import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  lstatSync,
  fstatSync,
  openSync,
  closeSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { BedrockProvider, validateSilos } from "../server/bedrock.js";
import { configureCatalog } from "../server/catalog.js";
import {
  AppError,
  artifactNames,
  type Principal,
} from "../server/contracts.js";
import type { Provider } from "../server/provider.js";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";

const Case = z
  .object({ subject: z.string().min(1).max(120), requestId: z.string().uuid() })
  .strict();
const Plan = z
  .object({
    version: z.literal(1),
    syntheticOnly: z.literal(true),
    mode: z.enum(["mock", "bedrock"]),
    receiptDirectory: z.string().min(1),
    ledgerFile: z.string().min(1),
    cases: z.array(Case).length(2),
    silos: z.unknown(),
  })
  .strict();
const scopes = ["documents:read", "analysis:write"];
const questions = [
  "Compare 2024 revenue and operating margins for ACME and BETA. Identify the source limitations and missing EBITDA.",
  "Summarize ACME's 2024 revenue, operating income and source limitations using only its annual report.",
];
const selections = [["acme-2024", "beta-2024", "kpis-2024"], ["acme-2024"]];
export function authorizeRuntimeAcceptance(bytes: Buffer, approval: string) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (approval !== digest)
    throw Error("Exact runtime acceptance plan approval required");
  const plan = Plan.parse(JSON.parse(bytes.toString("utf8")));
  const silos = validateSilos(plan.silos);
  if (
    new Set(plan.cases.map((c) => c.subject)).size !== 2 ||
    new Set(plan.cases.map((c) => c.requestId)).size !== 2
  )
    throw Error("Two distinct synthetic owners and request IDs required");
  if (
    Object.keys(silos).length !== 2 ||
    plan.cases.some((c) => !Object.hasOwn(silos, c.subject))
  )
    throw Error("Only the two approved silos are allowed");
  if (
    Object.values(silos).some(
      (s) => s.region !== "us-east-1" || s.model !== "openai.gpt-6-luna",
    )
  )
    throw Error("Only the approved region and model are allowed");
  return { plan, silos, digest };
}
function preserve(path: string, bytes: Buffer | string) {
  checkedPath(path);
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(value))
      throw Error(
        "Existing acceptance evidence differs; preserve it and reconcile",
      );
  } else writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}
async function runUnlocked(
  bytes: Buffer,
  approval: string,
  directory: string,
  options: {
    providerFactory?: () => Provider;
    liveApproved?: boolean;
    maxMs?: number;
    pollMs?: number;
  } = {},
) {
  const { plan, silos, digest } = authorizeRuntimeAcceptance(bytes, approval);
  if (!options.providerFactory && !options.liveApproved)
    throw Error("Live runtime acceptance is not approved");
  const folder = resolve(directory);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  preserve(join(folder, "approved-plan.json"), bytes);
  const store = new Store(join(folder, "acceptance.sqlite"));
  if (
    store
      .all()
      .some(
        (a) =>
          !plan.cases.some(
            (c) => c.subject === a.owner && c.requestId === a.requestId,
          ),
      )
  ) {
    store.close();
    throw Error("Acceptance state contains work outside this plan");
  }
  configureCatalog(
    Object.fromEntries(plan.cases.map((c, i) => [c.subject, selections[i]])),
  );
  const maxMs = options.maxMs ?? 20 * 60 * 1000;
  if (!(maxMs > 0 && maxMs <= 20 * 60 * 1000)) {
    store.close();
    throw Error("Acceptance monitor must be bounded to twenty minutes");
  }
  const provider = options.providerFactory?.() ?? new BedrockProvider(silos);
  if (provider.mode === "bedrock" && !options.liveApproved) {
    store.close();
    throw Error("Live runtime acceptance is not approved");
  }
  if (provider.mode !== plan.mode) {
    store.close();
    throw Error("Provider mode differs from approved plan");
  }
  const service = new Service(store, provider, maxMs);
  const principals: Principal[] = plan.cases.map((c) => ({
    id: c.subject,
    scopes,
  }));
  const results: Array<{
    subject: string;
    analysisId: string;
    providerId?: string;
    artifacts: Array<{ name: string; sha256: string }>;
  }> = [];
  try {
    for (let index = 0; index < plan.cases.length; index++) {
      const c = plan.cases[index],
        principal = principals[index];
      const analysis = await service.start(principal, {
        requestId: c.requestId,
        documentIds: selections[index],
        question: questions[index],
      });
      const deadline = Date.now() + maxMs;
      let current = service.get(principal, analysis.id);
      while (
        !["completed", "failed", "uncertain", "cancelled"].includes(
          current.status,
        )
      ) {
        if (Date.now() >= deadline)
          throw Error(
            "Acceptance monitor expired; work may continue. Reconcile and stop the recorded owned compute; do not retry with new IDs",
          );
        await service.tick();
        await new Promise((r) => setTimeout(r, options.pollMs ?? 2000));
        current = service.get(principal, analysis.id);
      }
      const record = store.get(principal, analysis.id);
      preserve(
        join(
          folder,
          `case-${index + 1}-${record.id}-${record.status}-${record.updatedAt}.json`,
        ),
        JSON.stringify(record, null, 2) + "\n",
      );
      if (current.status !== "completed" || !current.artifactReady)
        throw Error(
          `Acceptance stopped at ${current.status}; no next analysis or write replay`,
        );
      const artifacts = [];
      for (const name of artifactNames) {
        const data = await service.download(principal, analysis.id, name);
        preserve(join(folder, `case-${index + 1}-${name}`), data);
        artifacts.push({
          name,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
      results.push({
        subject: c.subject,
        analysisId: analysis.id,
        providerId: record.providerId,
        artifacts,
      });
    }
    const alice = results[0].analysisId;
    let denied = false;
    try {
      service.get(principals[1], alice);
    } catch (error) {
      denied =
        error instanceof AppError &&
        error.status === 404 &&
        error.code === "analysis_not_found";
    }
    if (!denied) throw Error("Cross-owner service isolation failed");
    denied = false;
    try {
      service.readDoc(principals[1], "beta-2024");
    } catch (error) {
      denied =
        error instanceof AppError &&
        error.status === 404 &&
        error.code === "document_not_found";
    }
    if (!denied) throw Error("Cross-owner source isolation failed");
    const summary = {
      planSha256: digest,
      mode: provider.mode,
      cases: results,
      crossOwnerServiceDenial: true,
      crossOwnerSourceDenial: true,
      limitations: [
        "Does not validate HTTP/JWT/ChatGPT or IAM/NFS denial",
        "Does not stop compute or remove resources",
        "Numeric/narrative acceptance still requires review",
      ],
    };
    preserve(
      join(folder, "completed.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    return summary;
  } finally {
    service.close();
  }
}

function checkedPath(path: string) {
  const absolute = resolve(path);
  const pieces = absolute.split("/").filter(Boolean);
  let cursor = "/";
  for (let index = 0; index < pieces.length; index++) {
    cursor = join(cursor, pieces[index]);
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      (index < pieces.length - 1 && !info.isDirectory()) ||
      (index === pieces.length - 1 &&
        !info.isDirectory() &&
        (!info.isFile() || info.nlink !== 1))
    )
      throw Error(
        "Acceptance paths must be canonical regular files and directories",
      );
  }
}
export async function runRuntimeAcceptance(
  bytes: Buffer,
  approval: string,
  directory: string,
  options: Parameters<typeof runUnlocked>[3] = {},
) {
  const { plan, digest } = authorizeRuntimeAcceptance(bytes, approval);
  const folder = resolve(directory),
    ledger = resolve(plan.ledgerFile);
  if (
    !isAbsolute(plan.receiptDirectory) ||
    folder !== plan.receiptDirectory ||
    !isAbsolute(plan.ledgerFile) ||
    ledger !== plan.ledgerFile ||
    ledger.startsWith(folder + "/") ||
    ledger === folder
  )
    throw Error(
      "Use the exact approved receipt directory and separate ledger file",
    );
  if (plan.mode === "bedrock" && !options.liveApproved)
    throw Error("Live runtime acceptance is not approved");
  if (plan.mode === "mock" && !options.providerFactory)
    throw Error("Mock acceptance needs a mock provider");
  const state = join(folder, "acceptance.sqlite"),
    marker = join(folder, "approved-plan.json"),
    lockPath = ledger + ".lock";
  for (const p of [
    folder,
    ledger,
    state,
    state + "-wal",
    state + "-shm",
    marker,
    lockPath,
  ])
    checkedPath(p);
  mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(ledger));
  if ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
    throw Error("Ledger parent must be private and owned by the operator");
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw Error("Acceptance operation locked; reconcile before another run");
  }
  const lockIdentity = fstatSync(lock);
  try {
    const initialized = existsSync(ledger);
    if (initialized) {
      if (!existsSync(state) || !existsSync(marker))
        throw Error(
          "Previously initialized acceptance state is missing; do not replay",
        );
      const identity = JSON.parse(readFileSync(ledger, "utf8"));
      if (
        identity.digest !== digest ||
        identity.mode !== plan.mode ||
        identity.state !== state
      )
        throw Error("Acceptance state identity mismatch");
      const db = new DatabaseSync(state, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT nonce FROM acceptance_identity WHERE singleton=1")
          .get();
        if (row?.nonce !== identity.nonce)
          throw Error("Acceptance database identity mismatch");
      } finally {
        db.close();
      }
    } else {
      if (existsSync(state) || existsSync(marker))
        throw Error(
          "Acceptance ledger missing for existing evidence; do not replay",
        );
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const info = lstatSync(folder);
      if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
        throw Error(
          "Receipt directory must be private and owned by the operator",
        );
      const nonce = randomUUID();
      writeFileSync(
        ledger,
        JSON.stringify({ digest, mode: plan.mode, state, nonce }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      const db = new DatabaseSync(state);
      try {
        db.exec(
          "CREATE TABLE acceptance_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), nonce TEXT NOT NULL)",
        );
        db.prepare("INSERT INTO acceptance_identity VALUES(1,?)").run(nonce);
      } finally {
        db.close();
      }
      chmodSync(state, 0o600);
      preserve(marker, bytes);
    }
    return await runUnlocked(bytes, approval, directory, options);
  } finally {
    closeSync(lock);
    const current = lstatSync(lockPath);
    if (current.ino === lockIdentity.ino && current.dev === lockIdentity.dev)
      unlinkSync(lockPath);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  if (!args.includes("--plan") || !args.includes("--approval"))
    throw Error(
      "Use --plan PATH --approval SHA256 [--execute --receipts PRIVATE_DIRECTORY]",
    );
  const bytes = readFileSync(value("--plan"));
  const approved = authorizeRuntimeAcceptance(bytes, value("--approval"));
  if (!args.includes("--execute"))
    console.log(
      JSON.stringify({
        valid: true,
        mode: "check-only",
        planSha256: approved.digest,
        cases: 2,
      }),
    );
  else {
    if (!args.includes("--receipts"))
      throw Error("Private receipt directory required");
    const result = await runRuntimeAcceptance(
      bytes,
      value("--approval"),
      value("--receipts"),
      { liveApproved: process.env.LIVE_AWS_CALLS === "approved" },
    );
    console.log(JSON.stringify(result));
  }
}
