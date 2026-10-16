import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSilos } from "../server/bedrock.js";

export const baselineModel = "openai.gpt-5.6-luna";
export const baselineWorkspace = "/mnt/workspace";
export const baselineSkillKey = "skills/hello-bma/SKILL.md";
export const baselineOutputKey = "verification.txt";
const fixture = new URL(
  "./baseline-fixtures/hello-bma/SKILL.md",
  import.meta.url,
);
export const baselineSkillBytes = readFileSync(fixture);
export const baselineSkillSha256 = createHash("sha256")
  .update(baselineSkillBytes)
  .digest("hex");

// Produces a reviewable copy. It never deploys, mutates the input or edits image assets.
export function baselineProfile(project: unknown, runtimeName: string) {
  const copy = structuredClone(project) as Record<string, any>;
  if (!copy || !Array.isArray(copy.runtimes))
    throw Error("CLI project required");
  const matches = copy.runtimes.filter((r: any) => r.name === runtimeName);
  if (matches.length !== 1)
    throw Error("Exactly one existing baseline Runtime required");
  const runtime = matches[0];
  const sessions = runtime.filesystemConfigurations?.filter(
    (f: any) => f.sessionStorage,
  );
  if (sessions?.length !== 1)
    throw Error("Exactly one existing session storage mount required");
  sessions[0].sessionStorage.mountPath = baselineWorkspace;
  runtime.lifecycleConfiguration = {
    idleRuntimeSessionTimeout: 28800,
    maxLifetime: 28800,
  };
  const values: Record<string, string> = {
    BMA_HOME_DIR: baselineWorkspace,
    BMA_STATE_DIR: baselineWorkspace + "/.bma",
    BMA_CODEX_HOME: baselineWorkspace + "/.codex",
  };
  const env = runtime.envVars ?? [];
  for (const [name, value] of Object.entries(values)) {
    const entry = env.find((e: any) => e.name === name);
    if (entry) entry.value = value;
    else env.push({ name, value });
  }
  runtime.envVars = env;
  return copy;
}

export function baselineSession(input: unknown) {
  const silo = validateSilos({ baseline: input }).baseline;
  if (silo.region !== "us-east-1" || silo.model !== baselineModel)
    throw Error("Baseline requires the documented us-east-1 model selection");
  return {
    agent: {
      model: baselineModel,
      instructions:
        "Use shell tools when explicitly requested. Report tool and command output exactly.",
    },
    environment: {
      type: "aws_bedrock_agentcore",
      runtime_arn: silo.runtimeArn,
      runtime_qualifier: "DEFAULT",
      workspace_directory: baselineWorkspace,
      capability_directories: [
        "/mnt/bma/skills",
        baselineWorkspace + "/skills",
      ],
    },
    role_arn: silo.roleArn,
    stream: false,
  };
}

// The stock CDK adapter copies skills automatically; the CLI adapter does not.
// Explicit first-turn setup preserves both official source files unchanged.
export const baselineVerificationCommand =
  "test ! -e /mnt/output/verification.txt && (set -C; printf 'BMA_OUTPUT_VERIFIED\\n' > /mnt/output/verification.txt) && cat /mnt/output/verification.txt";
export const baselinePrompts = [
  `Verify sha256sum /mnt/bma/${baselineSkillKey} equals ${baselineSkillSha256}. Stop on missing/mismatched input. Stop if /mnt/workspace/skills/hello-bma/SKILL.md already exists. Copy that exact file to that path, creating only its parent directories. Run sha256sum /mnt/workspace/skills/hello-bma/SKILL.md and require the same hash. Use separate shell commands for each hash check. Then run the hello-bma skill: execute its exact head and ls commands separately and report their outputs verbatim.`,
  `Write and read back the stock verification text using this exact shell command: ${baselineVerificationCommand}. Stop if the file already exists; preserve previous outputs.`,
] as const;
export function baselineEvent(step: 0 | 1) {
  return {
    events: [
      {
        type: "agent.session.input.message",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: baselinePrompts[step] }],
          },
        ],
      },
    ],
  };
}

type Command = {
  type: string;
  command: string;
  output: string;
  exit_code: number;
};
function commands(items: unknown[]): Command[] {
  return items.filter(
    (i): i is Command =>
      !!i &&
      typeof i === "object" &&
      (i as Command).type === "command_execution" &&
      typeof (i as Command).command === "string" &&
      typeof (i as Command).output === "string" &&
      (i as Command).exit_code === 0,
  );
}
export function verifyHello(items: unknown[]) {
  // Only independently decoded command evidence belongs here; this is not a
  // claim that the preview wire format has been validated live.
  const c = commands(items);
  const has = (command: string, output: (value: string) => boolean) =>
    c.some((i) => i.command.trim() === command && output(i.output));
  const hashAt = (path: string) =>
    has(
      "sha256sum " + path,
      (value) => value.trim() === baselineSkillSha256 + "  " + path,
    );
  if (
    !hashAt("/mnt/bma/" + baselineSkillKey) ||
    !hashAt("/mnt/workspace/skills/hello-bma/SKILL.md") ||
    !has(
      "cat /mnt/workspace/skills/hello-bma/SKILL.md | head -1",
      (value) => value.trim() === "---",
    ) ||
    !has("ls /mnt/workspace/skills", (value) =>
      value.trim().split(/\s+/).includes("hello-bma"),
    )
  )
    throw Error(
      "Successful source/copy hashes and exact stock hello-bma head/ls command evidence required; idle/text alone is insufficient",
    );
  return { stage: "hello-bma", sourceSha256: baselineSkillSha256 };
}
export function verifyBaselineOutput(
  body: Buffer,
  head: { contentLength: number; etag: string; versionId?: string },
  get: { etag: string; versionId?: string; preTurnOutputAbsent: boolean },
) {
  const expected = Buffer.from("BMA_OUTPUT_VERIFIED");
  if (
    !get.preTurnOutputAbsent ||
    !head.etag ||
    !head.versionId ||
    head.versionId === "null" ||
    get.etag !== head.etag ||
    get.versionId !== head.versionId ||
    head.contentLength !== body.length ||
    !(
      body.equals(expected) ||
      body.equals(Buffer.concat([expected, Buffer.from("\n")]))
    )
  )
    throw Error(
      "Fresh versioned S3 HEAD/GET metadata and bytes must match verification.txt exactly",
    );
  return {
    key: baselineOutputKey,
    bytes: body.length,
    etag: head.etag,
    versionId: head.versionId,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export function baselineCost() {
  // One proposed cumulative authorization, carrying the full previous reservation.
  // This is neither an observed invoice nor an AWS-enforced billing ceiling.
  const failureReservations = {
    oneRuntimeEightHoursAtHigherV2FullResources: 6.2464,
    natAndIpv4TwentyFourHours: 1.2,
    natOneGb: 0.045,
    internetOneGb: 0.09,
    twoTurnsModelAllowance: 1,
    newRequestsLogsAndSync: 0.5,
  };
  const priorReservationCarriedForward = 4.594;
  const requestedCumulativeBudgetUsd = 15;
  const committedPlanningReservation = Number(
    (
      priorReservationCarriedForward +
      Object.values(failureReservations).reduce((a, b) => a + b, 0)
    ).toFixed(6),
  );
  return {
    currency: "USD",
    status: "PROPOSED_HELD_NOT_APPROVED",
    requestedCumulativeBudgetUsd,
    priorReservationCarriedForward,
    failureReservations,
    unallocatedContingency: Number(
      (requestedCumulativeBudgetUsd - committedPlanningReservation).toFixed(6),
    ),
    totalReserved: requestedCumulativeBudgetUsd,
    billingCapEnforced: false,
    enforcement:
      "One session/two serial inputs, no write replay, 45-minute setup admission, 20-minute test, 30-minute compute-stop trigger, 90-minute cleanup start, 120-minute cleanup target, cleanup-only backstop through 24 hours",
    failureScenarioLimits:
      "Eight hours is per compute lifetime, not an overall session/spend cap. Failed host, credentials, control plane, inference cancellation or cleanup can exceed this reservation. No automatic budget increase or extra paid attempt is authorized.",
    priorInvoiceReconciled: false,
    retainedStorageReservationMonths: 1,
    newBuildsKeysImages: 0,
    stockRuntimeConfiguredHours: 8,
    liveAwsValidated: false,
  };
}

function main(args: string[]) {
  const allowed = ["--project", "--silo", "--runtime", "--out"];
  if (
    args.length !== 8 ||
    args.some((v, i) => i % 2 === 0 && !allowed.includes(v)) ||
    new Set(args.filter((_, i) => i % 2 === 0)).size !== 4
  )
    throw Error(
      "Check-only usage: npm run baseline:plan -- --project FILE --silo FILE --runtime NAME --out NEW_DIRECTORY",
    );
  const values = Object.fromEntries(
    args.reduce<Array<[string, string]>>(
      (p, v, i) => (i % 2 === 0 ? [...p, [v, args[i + 1]]] : p),
      [],
    ),
  );
  const project = baselineProfile(
    JSON.parse(readFileSync(values["--project"], "utf8")),
    values["--runtime"],
  );
  const request = baselineSession(
    JSON.parse(readFileSync(values["--silo"], "utf8")),
  );
  const output = resolve(values["--out"]);
  mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of Object.entries({
    "agentcore.proposed.json": project,
    "create-session.proposed.json": request,
    "hello-event.proposed.json": baselineEvent(0),
    "verification-event.proposed.json": baselineEvent(1),
    "cost.proposed.json": baselineCost(),
  }))
    writeFileSync(
      resolve(output, name),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  console.log(
    JSON.stringify({
      mode: "local-plan-only",
      output,
      awsCalls: 0,
      modelCalls: 0,
      cloudApprovalRequired: true,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2));
