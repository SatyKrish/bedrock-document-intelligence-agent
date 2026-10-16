/** Opt-in REAL service readback. Never starts an analysis or changes AWS resources. */
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { loadState } from "./apply.js";
import { Configuration, stackNames, type Config } from "./config.js";
import { verifyPlan, digest, type Plan } from "./approval.js";
import { sourceInventory } from "./source.js";
import { responseBytes, responseJson } from "./http.js";
import {
  readJson,
  writeJson,
  writeBytes,
  workspace,
  withDeploymentLock,
} from "./workspace.js";
import { documents } from "../server/catalog.js";
import { BedrockProvider, validateSilos } from "../server/bedrock.js";
import type { Analysis } from "../server/contracts.js";
const Cases = z
  .object({
    version: z.literal(1),
    syntheticOnly: z.literal(true),
    cases: z
      .array(
        z
          .object({
            subject: z.string().min(1),
            analysisId: z.string().uuid(),
            sessionId: z.string().min(1).max(256),
            tokenEnvironment: z.enum([
              "DOCINTEL_ACCEPTANCE_ALICE_TOKEN",
              "DOCINTEL_ACCEPTANCE_BOB_TOKEN",
            ]),
          })
          .strict(),
      )
      .length(2),
    summaries: z.enum(["disabled", "conservative-preview"]),
  })
  .strict();
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
export function authorizeReadback(
  c: Config,
  plan: Plan,
  approval: string,
  input: unknown,
) {
  verifyPlan(plan, approval, c, sourceInventory().digest);
  check(plan.phase === "deploy", "A real matching deploy plan is required");
  const cases = Cases.parse(input);
  check(
    new Set(cases.cases.map((v) => v.subject)).size === 2 &&
      new Set(cases.cases.map((v) => v.analysisId)).size === 2 &&
      new Set(cases.cases.map((v) => v.sessionId)).size === 2 &&
      new Set(cases.cases.map((v) => v.tokenEnvironment)).size === 2,
    "Two distinct owned principals/analyses/sessions/tokens required",
  );
  for (const item of cases.cases)
    check(
      c.principals.some((p) => p.subject === item.subject),
      "Case principal is not in the approved configuration",
    );
  return cases;
}
async function object(client: S3Client, bucket: string, key: string) {
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  check(
    head.ContentLength && head.ContentLength <= 524288,
    "Unexpected synthetic object size",
  );
  const got = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  check(got.Body, "Missing S3 body");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of got.Body as AsyncIterable<Uint8Array>) {
      size += part.byteLength;
      check(size <= 524288, "Oversized synthetic readback");
      chunks.push(Buffer.from(part));
    }
  } finally {
    (got.Body as { destroy?: () => void }).destroy?.();
  }
  return Buffer.concat(chunks);
}
export async function runReadback(
  c: Config,
  plan: Plan,
  approval: string,
  input: unknown,
  siloInput: unknown,
  browser = false,
) {
  const cases = authorizeReadback(c, plan, approval, input),
    silos = validateSilos(siloInput);
  const state = loadState(c),
    names = stackNames(c);
  check(
    state.sourceDigest === plan.sourceDigest,
    "Deployment state source does not match the approved live test",
  );
  for (const item of cases.cases) {
    const index = c.principals.findIndex((p) => p.subject === item.subject);
    const out = state.stacks[names.silos[index]]?.outputs;
    const silo = silos[item.subject];
    check(
      out &&
        silo &&
        out.RuntimeArn === silo.runtimeArn &&
        out.SessionRoleArn === silo.roleArn &&
        out.ApplicationSiloRoleArn === silo.applicationRoleArn &&
        out.InputsBucket === silo.inputBucket &&
        out.OutputsBucket === silo.outputBucket,
      "Readback silo is not in the exact owned deployment journal",
    );
    check(
      silo &&
        silo.region === c.region &&
        silo.runtimeArn.split(":")[4] === c.account,
      "Silo account/region mismatch",
    );
    check(
      process.env[item.tokenEnvironment],
      "Missing protected token environment; never use mock tokens",
    );
  }
  return withDeploymentLock(c.deploymentId, async () => {
    const records: any[] = [];
    const clients: S3Client[] = [];
    const mcps: Client[] = [];
    const provider = new BedrockProvider(
      silos,
      fetch,
      undefined,
      cases.summaries === "conservative-preview",
    );
    try {
      for (const item of cases.cases) {
        const token = process.env[item.tokenEnvironment]!;
        const api = async (path: string, expected = 200) => {
          const r = await fetch(c.publicOrigin + path, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          });
          check(r.status === expected, "Live application status mismatch");
          return r;
        };
        const config = await responseJson(await api("/api/config"));
        check(
          config.mode === "bedrock" &&
            config.identity?.issuer === c.identity.issuer &&
            config.identity?.audience === c.identity.audience,
          "Target is not the approved live service",
        );
        const expected = c.principals.find(
          (p) => p.subject === item.subject,
        )!.documents;
        const catalog = await responseJson(await api("/api/documents"));
        check(
          JSON.stringify(catalog.documents.map((d: any) => d.id).sort()) ===
            JSON.stringify([...expected].sort()),
          "Live catalog differs from approved grants",
        );
        const analysis = await responseJson(
          await api(`/api/analyses/${item.analysisId}`),
        );
        check(
          analysis.mode === "bedrock" && analysis.status === "completed",
          "Owned live analysis has not completed",
        );
        const summaries = analysis.analysisDetails?.reasoningSummaries;
        check(
          summaries && Array.isArray(summaries.summaries),
          "Missing summary availability contract",
        );
        if (cases.summaries === "disabled")
          check(
            summaries.status === "disabled" && summaries.summaries.length === 0,
            "Disabled summaries exposed",
          );
        else
          check(
            ["available", "unavailable"].includes(summaries.status),
            "Unknown public-summary status",
          );
        const allowed = new Set(["id", "turnId", "itemId", "text"]);
        for (const s of summaries.summaries)
          check(
            Object.keys(s).every((k) => allowed.has(k)),
            "Unexpected summary field; do not save raw reasoning",
          );
        const other = cases.cases.find((x) => x.subject !== item.subject)!;
        for (const path of [
          `/api/analyses/${other.analysisId}`,
          `/api/analyses/${other.analysisId}/artifacts`,
          `/api/analyses/${other.analysisId}/artifacts/kpis.csv`,
        ]) {
          const denied = await api(path, 404);
          await denied.body?.cancel();
        }
        for (const doc of documents.filter(
          (d) => !expected.includes(d.id as any),
        )) {
          const denied = await api(`/api/documents/${doc.id}`, 404);
          await denied.body?.cancel();
        }
        const silo = silos[item.subject];
        const s3 = new S3Client({
          region: c.region,
          credentials: fromTemporaryCredentials({
            masterCredentials: defaultProvider(),
            clientConfig: { region: c.region, maxAttempts: 1 },
            params: {
              RoleArn: silo.applicationRoleArn,
              RoleSessionName: "docintel-acceptance-readback",
            },
          }),
          maxAttempts: 1,
          requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
        });
        clients.push(s3);
        const manifest = JSON.parse(
          (
            await object(
              s3,
              silo.inputBucket,
              `inputs/${item.analysisId}/manifest.json`,
            )
          ).toString("utf8"),
        );
        check(
          manifest.analysisId === item.analysisId &&
            Array.isArray(manifest.documents),
          "Input manifest ownership mismatch",
        );
        check(
          JSON.stringify(manifest.documents.map((d: any) => d.id).sort()) ===
            JSON.stringify([...analysis.documentIds].sort()),
          "Staged selection differs from analysis",
        );
        for (const d of manifest.documents) {
          const fixture = documents.find((f) => f.id === d.id);
          check(
            fixture && expected.includes(d.id) && fixture.filename === d.file,
            "Unexpected input file",
          );
          const bytes = await object(
            s3,
            silo.inputBucket,
            `inputs/${item.analysisId}/${fixture.filename}`,
          );
          check(
            digest(bytes) === d.sha256 &&
              bytes.equals(Buffer.from(fixture.text)),
            "Staged bytes differ from synthetic fixture",
          );
        }
        for (const name of ["comparison.md", "kpis.csv"]) {
          const download = await responseBytes(
            await api(`/api/analyses/${item.analysisId}/artifacts/${name}`),
            524288,
          );
          const synced = await object(
            s3,
            silo.outputBucket,
            `${item.analysisId}/${name}`,
          );
          check(
            download.equals(synced),
            "S3 synchronized output differs from sealed API bytes",
          );
        }
        // Known foreign keys must fail specifically with AccessDenied, not merely NotFound.
        let denied = false;
        try {
          await s3.send(
            new HeadObjectCommand({
              Bucket: silos[other.subject].outputBucket,
              Key: `${other.analysisId}/kpis.csv`,
            }),
          );
        } catch (e) {
          denied = (e as any).$metadata?.httpStatusCode === 403;
        }
        check(denied, "Cross-principal S3 IAM denial not proved");
        const a = {
          id: item.analysisId,
          owner: item.subject,
          providerId: item.sessionId,
          documentIds: analysis.documentIds,
          question: analysis.question,
          requestId: analysis.requestId,
          status: "completed",
          createdAt: analysis.createdAt,
          updatedAt: analysis.updatedAt,
        } as Analysis;
        const session = await responseJson(
          await provider.request(
            a,
            "GET",
            `/openai/v1/agents/sessions/${encodeURIComponent(item.sessionId)}`,
          ),
        );
        check(
          session.id === item.sessionId &&
            session.role_arn === silo.roleArn &&
            session.environment?.runtime_arn === silo.runtimeArn &&
            session.status === "idle",
          "Managed session/runtime/role or terminal state mismatch",
        );
        let sessionDenied = false;
        try {
          const response = await provider.request(
            a,
            "GET",
            `/openai/v1/agents/sessions/${encodeURIComponent(other.sessionId)}`,
          );
          await response.body?.cancel();
        } catch (e) {
          sessionDenied = [403, 404].includes(
            (e as { status?: number }).status ?? 0,
          );
        }
        check(
          sessionDenied,
          "Cross-principal BMA session access denied by application role was not proved; stop synthetic rollout",
        );
        const mcp = new Client({
          name: "docintel-real-readback",
          version: "0.1.0",
        });
        mcps.push(mcp);
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(c.publicOrigin + "/mcp"), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
            reconnectionOptions: {
              maxRetries: 0,
              maxReconnectionDelay: 1000,
              initialReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          }),
        );
        check(
          (await mcp.listTools()).tools.length === 7,
          "MCP discovery mismatch",
        );
        const result = await mcp.callTool({
          name: "get_analysis",
          arguments: { analysisId: item.analysisId },
        });
        check(
          (result.structuredContent as any)?.data?.analysis?.status ===
            "completed",
          "MCP result mismatch",
        );
        const cross = await mcp.callTool({
          name: "get_analysis",
          arguments: { analysisId: other.analysisId },
        });
        check(cross.isError === true, "MCP cross-user denial failed");
        const artifact = await mcp.callTool({
          name: "get_artifact",
          arguments: { analysisId: item.analysisId, name: "kpis.csv" },
        });
        check(!artifact.isError, "MCP sealed artifact unavailable");
        records.push({
          principalIndex: records.length,
          analysisId: item.analysisId,
          managedSessionVerified: true,
          inputHashesVerified: true,
          s3OutputReadback: true,
          crossUserApiS3McpDenied: true,
          crossUserBmaSessionDenied: true,
          summaryStatus: summaries.status,
        });
      }
      let browserResult = "not-requested";
      if (browser) {
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch({ channel: "chrome" });
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", () => errors.push("pageerror"));
          await page.goto(c.publicOrigin, {
            waitUntil: "networkidle",
            timeout: 30000,
          });
          await page
            .getByRole("button", { name: "Sign in with your organization" })
            .waitFor();
          check(!errors.length, "Frontend page errors");
          writeBytes(
            join(workspace(c.deploymentId), "live-signed-out.png"),
            await page.screenshot({ fullPage: true }),
          );
          browserResult =
            "signed-out-live-page-only; actual PKCE and authenticated UI require human acceptance";
        } finally {
          await browser.close();
        }
      }
      const evidence = {
        kind: "real-readback",
        verifiedAt: new Date().toISOString(),
        planId: plan.id,
        sourceDigest: plan.sourceDigest,
        region: c.region,
        records,
        browser: browserResult,
        newInferenceRequests: 0,
        notProven: [
          "AgentCore NFS cross-mount denial (separate synthetic prompt test)",
          "Compute replacement/reconnect and cancellation under active execution",
          "Real IdP PKCE and ChatGPT-host consent/plugin installation",
        ],
      };
      writeJson(
        join(workspace(c.deploymentId), "live-readback.json"),
        evidence,
      );
      return evidence;
    } finally {
      for (const mcp of mcps) await mcp.close().catch(() => {});
      for (const s3 of clients) s3.destroy();
    }
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    console.log(
      "Real READ-ONLY acceptance: --config PATH --plan PATH --approve EXACT_PLAN_ID --cases PRIVATE_JSON --silos PRIVATE_JSON [--browser]. Requires two real short-lived token environments and the approved application's master AWS identity. Starts no analysis and changes no AWS resource. Do not run until live fixture work and access are approved.",
    );
    return;
  }
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    check(i >= 0 && args[i + 1], "Required acceptance argument missing");
    return args[i + 1];
  };
  const c = Configuration.parse(readJson(resolve(value("--config"))));
  const p = readJson(resolve(value("--plan"))) as Plan;
  console.log(
    JSON.stringify(
      await runReadback(
        c,
        p,
        value("--approve"),
        readJson(resolve(value("--cases"))),
        readJson(resolve(value("--silos"))),
        args.includes("--browser"),
      ),
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      "Live readback failed; inspect owned state and bounded checks. No credentials/remote bodies are logged.",
    );
    process.exitCode = 1;
  });
