import { responseBytes, responseJson } from "./http.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { verifyPlan, digest, canonical, type Plan } from "./approval.js";
import { sourceInventory } from "./source.js";
import {
  workspace,
  readJson,
  writeJson,
  writeBytes,
  withDeploymentLock,
} from "./workspace.js";
async function smokeLocked(
  c: Config,
  plan: Plan,
  approval: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
) {
  verifyPlan(plan, approval, c, sourceInventory().digest);
  if (plan.phase !== "deploy" || !token)
    throw Error("Deploy-plan approval and DOCINTEL_SMOKE_TOKEN are required");
  const api = async (path: string, body?: unknown) => {
    const r = await fetcher(c.publicOrigin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error(
        `Authenticated smoke HTTP ${r.status}; no raw token/body is logged`,
      );
    }
    return r;
  };
  const config = await responseJson(await api("/api/config"));
  if (
    config.mode !== "bedrock" ||
    config.identity?.issuer !== c.identity.issuer ||
    config.identity?.audience !== c.identity.audience
  )
    throw Error("Target is not the configured live service");
  const documents = await responseJson(await api("/api/documents"));
  if (
    !["acme-2024", "beta-2024", "kpis-2024"].every((id) =>
      documents.documents?.some((d: any) => d.id === id),
    )
  )
    throw Error("Smoke subject needs all three authorized synthetic fixtures");
  let subject: string;
  try {
    subject = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ).sub;
  } catch {
    throw Error("Smoke token lacks an expected subject");
  }
  if (!c.principals.some((p) => p.subject === subject))
    throw Error("Smoke token subject is not configured");
  const stateFile = join(workspace(c.deploymentId), "smoke.json");
  let s = existsSync(stateFile)
    ? readJson(stateFile)
    : {
        requestId: randomUUID(),
        phase: "prepared",
        configurationDigest: digest(canonical(c)),
        sourceDigest: plan.sourceDigest,
        subject,
      };
  if (
    s.configurationDigest !== digest(canonical(c)) ||
    s.sourceDigest !== plan.sourceDigest ||
    s.subject !== subject
  )
    throw Error("Smoke state belongs to another configuration/source/subject");
  if (!s.analysisId && s.phase !== "prepared") {
    const list = await responseJson(await api("/api/analyses"));
    const a = list.analyses?.find((a: any) => a.requestId === s.requestId);
    if (!a)
      throw Error(
        "Prior submission uncertain; no new paid request. Inspect/reconcile owned history.",
      );
    s.analysisId = a.id;
    writeJson(stateFile, s);
  }
  if (!s.analysisId) {
    s.phase = "submitting";
    writeJson(stateFile, s);
    const a = await responseJson(
      await api("/api/analyses", {
        requestId: s.requestId,
        documentIds: ["acme-2024", "beta-2024", "kpis-2024"],
        question:
          "Compare 2024 revenue and operating margins. Cite exact source quotes and generate comparison.md plus kpis.csv; do not invent EBITDA.",
      }),
    );
    if (typeof a.id !== "string")
      throw Error("Missing owned analysis ID; reconcile before another submit");
    s.analysisId = a.id;
    s.phase = "monitoring";
    writeJson(stateFile, s);
  }
  for (let i = 0; i < 150; i++) {
    const a = await responseJson(
      await api("/api/analyses/" + encodeURIComponent(s.analysisId)),
    );
    if (a.status === "completed") {
      for (const name of ["comparison.md", "kpis.csv"]) {
        const r = await api(
          `/api/analyses/${encodeURIComponent(s.analysisId)}/artifacts/${name}`,
        );
        const content = await responseBytes(r, 512 * 1024);
        if (!content.byteLength || content.byteLength > 512 * 1024)
          throw Error("Invalid/oversized report");
        writeBytes(join(workspace(c.deploymentId), name), Buffer.from(content));
      }
      s.phase = "completed";
      s.completedAt = new Date().toISOString();
      writeJson(stateFile, s);
      return {
        analysisId: s.analysisId,
        requestId: s.requestId,
        status: s.phase,
        reports: ["comparison.md", "kpis.csv"],
        liveQualification:
          "One synthetic run only; OAuth/ChatGPT, recovery and cross-user runtime isolation need separate acceptance",
      };
    }
    if (["failed", "cancelled", "uncertain"].includes(a.status))
      throw Error(
        "Smoke did not complete; reconcile/cancel owned work, never automatically retry inference",
      );
    await wait(2000);
  }
  // Cancellation is bounded and only this recorded analysis; confirmation is not invented.
  await api(`/api/analyses/${encodeURIComponent(s.analysisId)}/cancel`, {});
  s.phase = "cancel_requested";
  writeJson(stateFile, s);
  throw Error(
    "Smoke deadline: cancellation requested; confirm managed work stopped before cleanup",
  );
}

export async function smoke(
  c: Config,
  plan: Plan,
  approval: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
) {
  verifyPlan(plan, approval, c, sourceInventory().digest);
  return withDeploymentLock(c.deploymentId, () =>
    smokeLocked(c, plan, approval, token, fetcher, wait),
  );
}
