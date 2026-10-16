import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  baselineSession,
  baselineEvent,
  baselinePrompts,
  baselineVerificationCommand,
  baselineSkillBytes,
  baselineSkillSha256,
  baselineSkillKey,
  verifyHello,
  verifyBaselineOutput,
} from "./aws-baseline.js";
import {
  Journal,
  OfficialAwsCli,
  admission,
  heartbeat,
  deadlines,
  parsePlan,
  canonical,
  sha,
  hasTags,
  freshFilter,
  readIdentity,
  inventory,
  watchdogLease,
  bindLedger,
  provisionNetwork,
  cleanupNetwork,
  clock,
  type Plan,
  type AwsApi,
  type Clock,
} from "./baseline-control.js";
import { parseSse } from "../server/sse.js";
import { responseBytes } from "./http.js";

export interface BmaReply {
  status: number;
  requestId?: string;
  body: any;
}
export interface ObjectInfo {
  contentLength: number;
  etag: string;
  versionId?: string;
}
export interface EvidenceIo {
  bma(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<BmaReply>;
  stream(
    path: string,
    event: (value: any) => void,
    signal: AbortSignal,
  ): Promise<void>;
  head(bucket: string, key: string): Promise<ObjectInfo | undefined>;
  get(
    bucket: string,
    key: string,
    head: ObjectInfo,
  ): Promise<{ bytes: Buffer; etag: string; versionId?: string }>;
  stage(bucket: string): Promise<unknown>;
}
const opaque = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(v);
const boundedText = (v: unknown, max = 65536) =>
  typeof v === "string" && Buffer.byteLength(v) <= max;
export class LiveEvidenceIo implements EvidenceIo {
  private credentials;
  private s3: S3Client;
  constructor(
    private p: Plan,
    private j: Journal,
  ) {
    this.credentials = fromIni({ profile: p.profile });
    this.s3 = new S3Client({
      region: "us-east-1",
      credentials: this.credentials,
      maxAttempts: 1,
    });
  }
  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ) {
    const endpoint = "https://bedrock-mantle.us-east-1.api.aws";
    if (!path.startsWith("/openai/v1/agents/sessions") || !path.startsWith("/"))
      throw Error("Unsupported preview route");
    const url = new URL(path, endpoint);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const signer = new SignatureV4({
      credentials: this.credentials,
      region: "us-east-1",
      service: "bedrock-mantle",
      sha256: Sha256,
    });
    const signed = await signer.sign(
      new HttpRequest({
        protocol: "https:",
        hostname: url.hostname,
        path: url.pathname,
        query,
        method,
        headers: {
          host: url.hostname,
          "x-amzn-account-id": this.p.account,
          ...(body === undefined
            ? {
                accept: path.includes("/events")
                  ? "text/event-stream"
                  : "application/json",
              }
            : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    signal.throwIfAborted();
    return fetch(url, {
      method,
      headers: signed.headers,
      body: signed.body,
      signal,
      redirect: "error",
    });
  }
  async bma(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<BmaReply> {
    const controller = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(20000),
    ]);
    const response = await this.request(method, path, body, controller);
    const bytes = response.body
      ? await responseBytes(response, 2 * 1024 * 1024)
      : Buffer.alloc(0);
    // Capture exact bounded error bodies/request IDs privately; never signer headers.
    const requestId =
      response.headers.get("x-amzn-requestid") ??
      response.headers.get("x-amzn-request-id") ??
      response.headers.get("x-request-id") ??
      undefined;
    let data: any;
    try {
      data = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
    } catch {
      data = { boundedNonJsonBody: bytes.subarray(0, 65536).toString("utf8") };
    }
    this.j.evidence("http", {
      method,
      path,
      status: response.status,
      requestId,
      bodySha256: sha(bytes),
      ...(!response.ok
        ? { errorBody: bytes.subarray(0, 65536).toString("utf8") }
        : {}),
    });
    if (!response.ok)
      throw Error(
        "BMA HTTP " + response.status + "; inspect private request receipt",
      );
    return { status: response.status, requestId, body: data };
  }
  async stream(path: string, event: (value: any) => void, signal: AbortSignal) {
    const response = await this.request(
      "GET",
      path,
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    );
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel();
      throw Error("Invalid event stream");
    }
    for await (const frame of parseSse(response.body!, signal)) {
      event(frame);
    }
  }
  async head(bucket: string, key: string) {
    try {
      const value = await this.s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(20000) },
      );
      return {
        contentLength: value.ContentLength!,
        etag: value.ETag!,
        versionId: value.VersionId,
      };
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404) return undefined;
      throw Error("S3 HEAD failed; not proof of absence");
    }
  }
  async get(bucket: string, key: string, head: ObjectInfo) {
    const value = await this.s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: head.versionId,
        IfMatch: head.etag,
      }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
    const parts: Uint8Array[] = [];
    let length = 0;
    if (!value.Body) throw Error("Missing S3 object body");
    for await (const piece of value.Body as AsyncIterable<Uint8Array>) {
      length += piece.byteLength;
      if (length > 4096) {
        (value.Body as any).destroy?.();
        throw Error("Output exceeds stock bound");
      }
      parts.push(piece);
    }
    return {
      bytes: Buffer.concat(parts),
      etag: value.ETag!,
      versionId: value.VersionId,
    };
  }
  async stage(bucket: string) {
    return this.s3
      .send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: baselineSkillKey,
          Body: baselineSkillBytes,
          ContentLength: baselineSkillBytes.length,
          ContentType: "text/markdown",
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
          Metadata: { sha256: baselineSkillSha256 },
        }),
        { abortSignal: AbortSignal.timeout(20000) },
      )
      .then((x) => ({
        etag: x.ETag,
        versionId: x.VersionId,
        requestId: x.$metadata.requestId,
      }));
  }
}

export async function listItems(io: Pick<EvidenceIo, "bma">, base: string) {
  const items: any[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      limit: "100",
      order: "asc",
      ...(after ? { after } : {}),
    });
    const { body } = await io.bma("GET", base + "/items?" + query);
    if (!Array.isArray(body.data) || typeof body.has_more !== "boolean")
      throw Error("Unknown durable item envelope");
    for (const item of body.data) {
      if (!opaque(item.id) || items.some((i) => i.id === item.id))
        throw Error("Invalid/duplicate durable item ID");
      items.push(item);
    }
    if (!body.has_more) return items;
    if (!opaque(body.last_id) || seen.has(body.last_id))
      throw Error("Invalid/looping opaque cursor");
    seen.add(body.last_id);
    after = body.last_id;
  }
  throw Error("Durable item page limit");
}
function messageText(item: any) {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  return item.content
    .map((v: any) =>
      ["input_text", "output_text", "text"].includes(v.type) &&
      typeof v.text === "string"
        ? v.text
        : "",
    )
    .join("");
}
export function correlateTurn(
  items: any[],
  before: Set<string>,
  prompt: string,
) {
  const fresh = items.filter((i) => !before.has(i.id));
  const inputs = fresh.filter(
    (i) => i.role === "user" && messageText(i) === prompt && opaque(i.turn_id),
  );
  if (inputs.length !== 1) return undefined;
  const turn = inputs[0].turn_id;
  if (fresh.some((i) => i.role === "user" && i.id !== inputs[0].id))
    throw Error("Unexpected additional user input");
  return {
    turnId: turn as string,
    items: fresh.filter((i) => i.turn_id === turn),
  };
}
function evidenceItems(items: any[]) {
  return items.map((i) => ({
    id: i.id,
    turn_id: i.turn_id,
    type: i.type,
    role: i.role,
    ...(i.type === "command_execution" &&
    boundedText(i.command, 4096) &&
    boundedText(i.output)
      ? {
          command: i.command,
          output: i.output,
          exit_code: i.exit_code,
          status: i.status,
        }
      : { fields: Object.keys(i).slice(0, 30) }),
  }));
}
export function runtimeBindings(
  events: any[],
  environmentId: string,
  activation: number,
) {
  const bindings = new Map<
    string,
    { runtimeSessionId: string; timestamp: number; eventId: string }
  >();
  for (const e of events) {
    if (
      !Number.isSafeInteger(e.timestamp) ||
      e.timestamp < activation - 2000 ||
      !opaque(e.eventId) ||
      typeof e.message !== "string"
    )
      continue;
    let log: any;
    try {
      log = JSON.parse(e.message);
    } catch {
      continue;
    }
    if (
      log.message === "exec_server_start" &&
      log.environment_id === environmentId &&
      typeof log.runtimeSessionId === "string" &&
      /^[A-Za-z0-9_-]{33,256}$/.test(log.runtimeSessionId)
    )
      bindings.set(log.runtimeSessionId, {
        runtimeSessionId: log.runtimeSessionId,
        timestamp: e.timestamp,
        eventId: e.eventId,
      });
  }
  return [...bindings.values()];
}
export async function captureRuntime(
  p: Plan,
  j: Journal,
  api: AwsApi,
  c: Clock = clock,
) {
  const session = j.read("session");
  const activation = j.read("activation");
  if (!session?.environmentId || !activation) return [];
  const runtimeId = (p.silo as any).runtimeArn.split("/").at(-1);
  const group = `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`;
  const events: any[] = [];
  let next: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = await api.call("logs", "filter-log-events", {
      logGroupName: group,
      startTime: activation.at - 2000,
      limit: 1000,
      ...(next ? { nextToken: next } : {}),
    });
    const values = response.events ?? [];
    if (!Array.isArray(values)) throw Error("Invalid log envelope");
    events.push(...values);
    // These are private synthetic stock lifecycle logs, not application output.
    j.evidence("runtime-logs", { group, events: values });
    if (!response.nextToken || response.nextToken === next) break;
    if (seen.has(response.nextToken) || page === 19)
      throw Error("Log pagination limit");
    seen.add(response.nextToken);
    next = response.nextToken;
  }
  const bindings = runtimeBindings(
    events,
    session.environmentId,
    activation.at,
  );
  for (const binding of bindings) {
    const name = "runtime-" + sha(binding.runtimeSessionId).slice(0, 32);
    const prior = j.read(name);
    if (
      prior &&
      (prior.environmentId !== session.environmentId ||
        prior.runtimeArn !== (p.silo as any).runtimeArn)
    )
      throw Error("Runtime binding identity drift");
    if (!prior)
      j.put(name, {
        ...binding,
        environmentId: session.environmentId,
        runtimeArn: (p.silo as any).runtimeArn,
      });
  }
  return { bindings, events, at: c.now() };
}

export async function collectBaseline(
  p: Plan,
  j: Journal,
  io: EvidenceIo,
  api: AwsApi,
  c: Clock = clock,
) {
  const silo = parsePlan(
    Buffer.from(JSON.stringify(p)),
    sha(JSON.stringify(p)),
  ).silo;
  admission(j, p, c, "test");
  if (await io.head(silo.inputBucket, baselineSkillKey))
    throw Error("Stock input exists; preserve instead of overwrite");
  if (await io.head(silo.outputBucket, "verification.txt"))
    throw Error("Baseline output exists; preserve instead of overwrite");
  j.put("output-absent-before-session", {
    at: c.now(),
    bucket: silo.outputBucket,
    key: "verification.txt",
    absent: true,
  });
  await j.once(
    "stage-stock",
    {
      bucket: silo.inputBucket,
      key: baselineSkillKey,
      sha256: baselineSkillSha256,
    },
    () => {
      admission(j, p, c, "test");
      return io.stage(silo.inputBucket);
    },
  );
  const inputHead = await io.head(silo.inputBucket, baselineSkillKey);
  if (!inputHead?.versionId) throw Error("Staged version unavailable");
  const input = await io.get(silo.inputBucket, baselineSkillKey, inputHead);
  if (
    inputHead.contentLength !== baselineSkillBytes.length ||
    input.versionId !== inputHead.versionId ||
    input.etag !== inputHead.etag ||
    !input.bytes.equals(baselineSkillBytes)
  )
    throw Error("Staged skill bytes/version differ");
  j.put("input-verified", { ...inputHead, sha256: baselineSkillSha256 });
  // Starting this conservative timer before create bounds even slow activation.
  j.put("activation", { at: c.now() });
  const created = await j.once("create-session", baselineSession(silo), () => {
    admission(j, p, c, "test");
    return io.bma("POST", "/openai/v1/agents/sessions", baselineSession(silo));
  });
  const session = created.body;
  if (
    !opaque(session.id) ||
    !opaque(session.environment?.id) ||
    session.environment.runtime_arn !== silo.runtimeArn ||
    session.role_arn !== silo.roleArn
  )
    throw Error("Created session identity/ownership not proven");
  j.put("session", {
    id: session.id,
    environmentId: session.environment.id,
    runtimeArn: silo.runtimeArn,
    roleArn: silo.roleArn,
    requestId: created.requestId,
  });
  const base = "/openai/v1/agents/sessions/" + encodeURIComponent(session.id);
  const streamAbort = new AbortController();
  let streamBytes = 0;
  let streamCount = 0;
  const stream = (async () => {
    while (!streamAbort.signal.aborted) {
      try {
        await io.stream(
          base + "/events?stream=true",
          (value) => {
            if (
              ++streamCount > 3000 ||
              (streamBytes += Buffer.byteLength(JSON.stringify(value))) >
                5 * 1024 * 1024
            ) {
              streamAbort.abort();
              return;
            }
            j.evidence("event", {
              type: value.type,
              turnId: value.turn_id ?? value.turn?.id,
              sessionId: value.session_id ?? value.session?.id,
              status: value.turn?.status,
              ...(value.type === "agent.session.error"
                ? { error: value.error }
                : {}),
            });
          },
          streamAbort.signal,
        );
      } catch {
        if (!streamAbort.signal.aborted)
          j.evidence("event-disconnect", { at: c.now() });
      }
      if (!streamAbort.signal.aborted) await c.sleep(1000);
    }
  })();
  const testEnd = j.read("activation").at + p.limits.testMinutes * 60000;
  const testAdmission = () => {
    admission(j, p, c, "test");
    if (c.now() >= testEnd)
      throw Error("Twenty-minute baseline deadline; no new input");
  };
  try {
    for (const step of [0, 1] as const) {
      testAdmission();
      if (step === 1 && (await io.head(silo.outputBucket, "verification.txt")))
        throw Error("Preexisting output before write turn");
      if (step === 1)
        j.put("output-absent-before-turn", { at: c.now(), absent: true });
      const runtimeNow = await api.call(
        "bedrock-agentcore-control",
        "get-agent-runtime",
        { agentRuntimeId: silo.runtimeArn.split("/").at(-1) },
      );
      if (
        runtimeNow.agentRuntimeArn !== silo.runtimeArn ||
        runtimeNow.agentRuntimeVersion !== p.runtimeVersion ||
        runtimeNow.roleArn !== p.runtimeExecutionRoleArn
      )
        throw Error("Runtime changed after preflight; no new turn");
      const before = new Set((await listItems(io, base)).map((i) => i.id));
      testAdmission();
      await j.once("turn-" + step, baselineEvent(step), () => {
        testAdmission();
        return io.bma(
          "POST",
          base + "/events",
          baselineEvent(step),
          AbortSignal.timeout(Math.min(20000, testEnd - c.now())),
        );
      });
      for (;;) {
        admission(j, p, c, "test");
        if (c.now() >= testEnd) throw Error("Twenty-minute baseline deadline");
        const current = await io.bma("GET", base);
        if (
          current.body.id !== session.id ||
          current.body.role_arn !== silo.roleArn ||
          current.body.environment?.runtime_arn !== silo.runtimeArn ||
          current.body.environment?.id !== session.environment.id
        )
          throw Error("Session identity drift");
        const items = await listItems(io, base);
        j.evidence("items", evidenceItems(items));
        const turn = correlateTurn(items, before, baselinePrompts[step]);
        const runtimeEvidence = await captureRuntime(p, j, api, c);
        if (current.body.status === "failed")
          throw Error("Managed session failed");
        if (
          turn &&
          current.body.status === "idle" &&
          turn.items.some((i) => i.role === "assistant")
        ) {
          if (
            Array.isArray(runtimeEvidence) ||
            !runtimeEvidence.bindings.length
          )
            throw Error("Cannot bind owned Runtime for cleanup; no next turn");
          if (step === 0) verifyHello(turn.items);
          else if (
            !turn.items.some(
              (i) =>
                i.type === "command_execution" &&
                i.exit_code === 0 &&
                typeof i.command === "string" &&
                i.command.trim() === baselineVerificationCommand &&
                typeof i.output === "string" &&
                i.output.trim() === "BMA_OUTPUT_VERIFIED",
            )
          )
            throw Error(
              "Missing successful output write/read command evidence",
            );
          j.put("turn-" + step + "-verified", {
            turnId: turn.turnId,
            items: evidenceItems(turn.items),
          });
          break;
        }
        if (!["idle", "in_progress"].includes(current.body.status))
          throw Error("Unknown session status");
        await c.sleep(2000);
      }
    }
    const outputEnd = Math.min(testEnd, c.now() + 180000);
    while (c.now() < outputEnd) {
      admission(j, p, c, "test");
      const head = await io.head(silo.outputBucket, "verification.txt");
      if (head) {
        const get = await io.get(silo.outputBucket, "verification.txt", head);
        const result = verifyBaselineOutput(get.bytes, head, {
          ...get,
          preTurnOutputAbsent: !!j.read("output-absent-before-turn")?.absent,
        });
        j.put("output-verified", result);
        j.put("baseline-passed", {
          at: c.now(),
          sessionId: session.id,
          output: result,
        });
        return result;
      }
      await c.sleep(2000);
    }
    throw Error("Output synchronization deadline");
  } finally {
    streamAbort.abort();
    await stream;
  }
}

export async function reconcileSession(p: Plan, j: Journal, io: EvidenceIo) {
  if (j.read("session") || !j.read("create-session-intent")) return;
  const silo = p.silo as any;
  const started = j.read("activation")?.at;
  const candidates: any[] = [];
  let after: string | undefined;
  const cursors = new Set<string>();
  for (let n = 0; n < 20; n++) {
    const q = new URLSearchParams({
      limit: "100",
      order: "desc",
      ...(after ? { after } : {}),
    });
    const { body } = await io.bma("GET", "/openai/v1/agents/sessions?" + q);
    if (!Array.isArray(body.data) || typeof body.has_more !== "boolean")
      throw Error("Invalid session list");
    for (const s of body.data)
      if (
        s.role_arn === silo.roleArn &&
        s.environment?.runtime_arn === silo.runtimeArn &&
        typeof s.created_at === "number" &&
        s.created_at * 1000 >= started - 2000
      )
        candidates.push(s);
    if (!body.has_more) break;
    if (!opaque(body.last_id) || cursors.has(body.last_id) || n === 19)
      throw Error("Session reconciliation bound");
    cursors.add(body.last_id);
    after = body.last_id;
  }
  if (
    candidates.length !== 1 ||
    !opaque(candidates[0].id) ||
    !opaque(candidates[0].environment?.id)
  )
    throw Error("Ambiguous session create remains unresolved");
  j.put("session", {
    id: candidates[0].id,
    environmentId: candidates[0].environment.id,
    runtimeArn: silo.runtimeArn,
    roleArn: silo.roleArn,
    reconciled: true,
  });
}
export async function stopOwned(
  p: Plan,
  j: Journal,
  io: EvidenceIo,
  api: AwsApi,
  c: Clock = clock,
) {
  const problems: string[] = [];
  try {
    await reconcileSession(p, j, io);
  } catch {
    problems.push("session-reconciliation");
  }
  const session = j.read("session"),
    silo = p.silo as any;
  let cancelled = !j.read("create-session-intent");
  if (session) {
    try {
      const current = (
        await io.bma(
          "GET",
          "/openai/v1/agents/sessions/" + encodeURIComponent(session.id),
        )
      ).body;
      if (
        current.id !== session.id ||
        current.role_arn !== silo.roleArn ||
        current.environment?.runtime_arn !== silo.runtimeArn ||
        current.environment?.id !== session.environmentId
      )
        throw Error("Stop ownership drift");
      if (!["idle", "failed"].includes(current.status))
        await io.bma(
          "POST",
          "/openai/v1/agents/sessions/" +
            encodeURIComponent(session.id) +
            "/events",
          { events: [{ type: "agent.session.input.cancel" }] },
        );
      cancelled = ["idle", "failed"].includes(current.status);
    } catch {
      problems.push("bma-cancellation-or-status");
    }
  }
  let observed: Awaited<ReturnType<typeof captureRuntime>> = [];
  try {
    observed = await captureRuntime(p, j, api, c);
  } catch {
    problems.push("fresh-runtime-logs");
  }
  const saved: any[] = [];
  for (const name of (await import("node:fs")).readdirSync(j.directory)) {
    if (!/^runtime-[a-f0-9]{32}\.json$/.test(name)) continue;
    const value = j.read(name.slice(0, -5));
    if (
      !session ||
      value.runtimeArn !== silo.runtimeArn ||
      value.environmentId !== session.environmentId ||
      !/^[A-Za-z0-9_-]{33,256}$/.test(value.runtimeSessionId) ||
      sha(value.runtimeSessionId).slice(0, 32) !== name.slice(8, -5) ||
      !opaque(value.eventId) ||
      value.timestamp < (j.read("activation")?.at ?? Infinity) - 2000
    )
      throw Error("Invalid saved Runtime binding");
    saved.push(value);
  }
  const bindings = new Map(saved.map((v) => [v.runtimeSessionId, v]));
  if (!Array.isArray(observed))
    for (const v of observed.bindings) bindings.set(v.runtimeSessionId, v);
  let confirmed = bindings.size > 0;
  // Known owned Runtime IDs remain stoppable even if BMA or fresh logs are down.
  for (const binding of bindings.values()) {
    try {
      const name =
        "cleanup-stop-" +
        sha(binding.runtimeSessionId + binding.eventId).slice(0, 32);
      const intent = j.read(name) ?? {
        at: c.now(),
        runtimeArn: silo.runtimeArn,
        runtimeSessionId: binding.runtimeSessionId,
        clientToken: sha(p.runId + binding.runtimeSessionId + binding.eventId),
      };
      j.put(name, intent);
      await api.call("bedrock-agentcore", "stop-runtime-session", {
        agentRuntimeArn: silo.runtimeArn,
        qualifier: "DEFAULT",
        runtimeSessionId: binding.runtimeSessionId,
        clientToken: intent.clientToken,
      });
      j.evidence("cleanup-stop-ack", {
        runtimeSessionId: binding.runtimeSessionId,
        at: c.now(),
      });
      const logs = (Array.isArray(observed) ? [] : observed.events)
        .map((e) => {
          try {
            return { ...JSON.parse(e.message), at: e.timestamp };
          } catch {
            return {};
          }
        })
        .filter((l) => l.runtimeSessionId === binding.runtimeSessionId);
      const signal = logs
        .filter(
          (l) =>
            l.message === "signal" &&
            l.signal === 15 &&
            l.at >= intent.at - 2000,
        )
        .at(-1);
      if (
        !signal ||
        c.now() < signal.at + 30000 ||
        logs.some((l) => l.message === "exec_server_start" && l.at > signal.at)
      )
        confirmed = false;
    } catch {
      confirmed = false;
      problems.push("runtime-stop-" + binding.runtimeSessionId);
    }
  }
  if (problems.length)
    j.evidence("cleanup-stop-problems", {
      at: c.now(),
      problems,
      authoritativeIds: [...bindings.keys()],
    });
  if (confirmed)
    j.evidence("cleanup-compute-proof", {
      at: c.now(),
      runtimeSessionIds: [...bindings.keys()],
    });
  return (!j.read("create-session-intent") || confirmed) && cancelled;
}
export async function restoreModel(p: Plan, j: Journal, api: AwsApi) {
  if (!j.read("session-policy-intent")) return;
  const role = (p.silo as any).roleArn.split("/").at(-1)!;
  const current = await api.call("iam", "get-role-policy", {
    RoleName: role,
    PolicyName: p.sessionPolicyName,
  });
  if (
    canonical(current.PolicyDocument) === canonical(p.originalSessionPolicy)
  ) {
    j.put("cleanup-policy-restored", { role });
    return;
  }
  if (canonical(current.PolicyDocument) !== canonical(p.proposedSessionPolicy))
    throw Error("Policy drift; preserve foreign change");
  await api.call("iam", "put-role-policy", {
    RoleName: role,
    PolicyName: p.sessionPolicyName,
    PolicyDocument: JSON.stringify(p.originalSessionPolicy),
  });
  const read = await api.call("iam", "get-role-policy", {
    RoleName: role,
    PolicyName: p.sessionPolicyName,
  });
  if (canonical(read.PolicyDocument) !== canonical(p.originalSessionPolicy))
    throw Error("Policy restoration unconfirmed");
  j.put("cleanup-policy-restored", { role });
}
async function confirmKnownNetworkAbsent(p: Plan, j: Journal, api: AwsApi) {
  const failures: string[] = [];
  const operations = [
    "subnet",
    "igw",
    "attach-igw",
    "public-rt",
    "public-route",
    "public-association",
    "eip",
    "nat",
    "private-route",
    "bob-egress",
  ];
  for (const name of operations)
    if (j.read(name + "-intent") && !j.read(name + "-result"))
      failures.push("unresolved-write-" + name);
  const known: Array<[string, string, string, string, string, string]> = [];
  const add = (
    name: string,
    id: any,
    op: string,
    arg: string,
    field: string,
    key: string,
  ) => {
    if (id) known.push([name, op, arg, field, key, id]);
  };
  // The last tuple value is the exact known physical ID, never a tag-only absence proof.
  add(
    "subnet",
    j.read("subnet-result")?.value?.Subnet?.SubnetId,
    "describe-subnets",
    "SubnetIds",
    "Subnets",
    "SubnetId",
  );
  add(
    "igw",
    j.read("igw-result")?.value?.InternetGateway?.InternetGatewayId,
    "describe-internet-gateways",
    "InternetGatewayIds",
    "InternetGateways",
    "InternetGatewayId",
  );
  add(
    "public-rt",
    j.read("public-rt-result")?.value?.RouteTable?.RouteTableId,
    "describe-route-tables",
    "RouteTableIds",
    "RouteTables",
    "RouteTableId",
  );
  add(
    "eip",
    j.read("eip-result")?.value?.AllocationId,
    "describe-addresses",
    "AllocationIds",
    "Addresses",
    "AllocationId",
  );
  add(
    "nat",
    j.read("nat-result")?.value?.NatGateway?.NatGatewayId,
    "describe-nat-gateways",
    "NatGatewayIds",
    "NatGateways",
    "NatGatewayId",
  );
  for (const rule of j.read("bob-egress-result")?.value?.SecurityGroupRules ??
    [])
    add(
      "rule",
      rule.SecurityGroupRuleId,
      "describe-security-group-rules",
      "SecurityGroupRuleIds",
      "SecurityGroupRules",
      "SecurityGroupRuleId",
    );
  const gone: Record<string, string> = {
    "describe-subnets": "InvalidSubnetID.NotFound",
    "describe-internet-gateways": "InvalidInternetGatewayID.NotFound",
    "describe-route-tables": "InvalidRouteTableID.NotFound",
    "describe-addresses": "InvalidAllocationID.NotFound",
    "describe-nat-gateways": "NatGatewayNotFound",
    "describe-security-group-rules": "InvalidSecurityGroupRuleId.NotFound",
  };
  for (const [name, op, arg, field, key, id] of known) {
    const deletion: Record<string, { op: string; input: any }> = {
      subnet: { op: "delete-subnet", input: { SubnetId: id } },
      igw: { op: "delete-internet-gateway", input: { InternetGatewayId: id } },
      "public-rt": { op: "delete-route-table", input: { RouteTableId: id } },
      eip: { op: "release-address", input: { AllocationId: id } },
      nat: { op: "delete-nat-gateway", input: { NatGatewayId: id } },
      rule: {
        op: "revoke-security-group-egress",
        input: { GroupId: p.bobSecurityGroup, SecurityGroupRuleIds: [id] },
      },
    };
    const acknowledged = !!j.read(
      "cleanup-ack-" + sha(canonical(deletion[name])).slice(0, 40),
    );
    try {
      const x = await api.call("ec2", op, { [arg]: [id] });
      j.evidence("cleanup-known-id", { op, id, result: x });
      const rows = inventory(x, field, key);
      const present = rows.filter((v) => v[key] === id);
      if (
        op === "describe-nat-gateways" &&
        present.length === 1 &&
        present[0].State === "deleted"
      ) {
        j.put("cleanup-nat-terminal-" + sha(id).slice(0, 32), {
          id,
          state: "deleted",
        });
      } else if (present.length) failures.push("known-id-" + name);
      else if (!acknowledged) failures.push("never-deleted-" + name);
    } catch (error: any) {
      if (error?.code !== gone[op] || !acknowledged)
        failures.push("unconfirmed-id-" + name);
      else j.evidence("cleanup-known-id-absent", { op, id, code: error.code });
    }
  }
  if (
    j.read("private-route-result") &&
    !j.read(
      "cleanup-ack-" +
        sha(
          canonical({
            op: "delete-route",
            input: {
              RouteTableId: p.privateRouteTable,
              DestinationCidrBlock: "0.0.0.0/0",
            },
          }),
        ).slice(0, 40),
    )
  )
    failures.push("private-route-never-deleted");
  if (j.read("private-route-intent"))
    try {
      const x = await api.call("ec2", "describe-route-tables", {
        RouteTableIds: [p.privateRouteTable],
      });
      const table = inventory(x, "RouteTables", "RouteTableId")[0];
      if (
        !table ||
        !Array.isArray(table.Routes) ||
        table.Routes.some((v: any) => v.DestinationCidrBlock === "0.0.0.0/0")
      )
        failures.push("private-default-still-present");
    } catch {
      failures.push("private-default-unconfirmed");
    }
  return failures;
}
export async function watchdogCycle(
  p: Plan,
  j: Journal,
  io: EvidenceIo,
  api: AwsApi,
  c: Clock = clock,
) {
  heartbeat(j, c.now());
  await readIdentity(api, p);
  const arm = j.read("armed");
  if (
    !arm ||
    !Number.isFinite(arm.startedAt) ||
    !Number.isFinite(c.now()) ||
    (j.read("activation") && !Number.isFinite(j.read("activation").at))
  )
    throw Error("Watchdog not armed or invalid clock");
  const d = deadlines(arm.startedAt, p, j.read("activation")?.at);
  const shouldClean =
    j.read("cleanup-requested") ||
    j.read("cleanup-started") ||
    c.now() >= Math.min(d.cleanupStart, d.computeStop) ||
    (c.now() >= d.setup && !j.read("activation"));
  if (!shouldClean) {
    try {
      await captureRuntime(p, j, api, c);
    } catch {
      j.evidence("capture-unavailable", { at: c.now() });
    }
    return false;
  }
  if (!j.read("cleanup-started")) j.put("cleanup-started", { at: c.now() });
  const failures: string[] = [];
  let compute = false;
  try {
    compute = await stopOwned(p, j, io, api, c);
  } catch {
    failures.push("owned-compute-stop");
  }
  try {
    await restoreModel(p, j, api);
  } catch {
    failures.push("model-policy-restore");
  }
  try {
    failures.push(...(await cleanupNetwork(p, j, api, c)));
  } catch {
    failures.push("network-read-or-delete");
  }
  // Verify absence again, after mutation responses. A successful delete ACK alone is not completion.
  for (const [op, field, filters] of [
    ["describe-nat-gateways", "NatGateways", "Filter"],
    ["describe-addresses", "Addresses", "Filters"],
    ["describe-subnets", "Subnets", "Filters"],
    ["describe-internet-gateways", "InternetGateways", "Filters"],
    ["describe-route-tables", "RouteTables", "Filters"],
    ["describe-security-group-rules", "SecurityGroupRules", "Filters"],
  ] as const) {
    try {
      const x = await api.call("ec2", op, { [filters]: freshFilter(p) });
      j.evidence("cleanup-absence", { op, result: x });
      const idFields: Record<string, string> = {
        NatGateways: "NatGatewayId",
        Addresses: "AllocationId",
        Subnets: "SubnetId",
        InternetGateways: "InternetGatewayId",
        RouteTables: "RouteTableId",
        SecurityGroupRules: "SecurityGroupRuleId",
      };
      if (
        inventory(x, field, idFields[field]).some(
          (v: any) => op !== "describe-nat-gateways" || v.State !== "deleted",
        )
      )
        failures.push(op);
    } catch {
      failures.push(op);
    }
  }
  failures.push(...(await confirmKnownNetworkAbsent(p, j, api)));
  if (c.now() >= d.cleanupEnd && !j.read("cleanup-deadline-breach"))
    j.put("cleanup-deadline-breach", {
      at: c.now(),
      failures,
      computeConfirmed: compute,
    });
  if (!failures.length && compute) {
    j.put("cleanup-completed", { at: c.now() });
    return true;
  }
  j.evidence("cleanup-pending", {
    at: c.now(),
    failures,
    computeConfirmed: compute,
  });
  return false;
}

export async function preflight(
  p: Plan,
  j: Journal,
  api: AwsApi,
  io: EvidenceIo,
  c: Clock = clock,
) {
  admission(j, p, c, "setup");
  j.put("caller", await readIdentity(api, p));
  const silo = p.silo as any;
  const vpc = (await api.call("ec2", "describe-vpcs", { VpcIds: [p.vpc] }))
    .Vpcs?.[0];
  if (
    !vpc ||
    !hasTags(vpc, p) ||
    vpc.OwnerId !== p.account ||
    vpc.CidrBlock !== "10.88.0.0/24" ||
    vpc.IsDefault
  )
    throw Error("Unowned or wrong isolated VPC");
  const subnet = (
    await api.call("ec2", "describe-subnets", { SubnetIds: [p.privateSubnet] })
  ).Subnets?.[0];
  if (
    !subnet ||
    !hasTags(subnet, p) ||
    subnet.VpcId !== p.vpc ||
    subnet.AvailabilityZoneId !== p.azId ||
    subnet.CidrBlock !== "10.88.0.0/26" ||
    subnet.MapPublicIpOnLaunch
  )
    throw Error("Private subnet changed");
  const group = (
    await api.call("ec2", "describe-security-groups", {
      GroupIds: [p.bobSecurityGroup],
    })
  ).SecurityGroups?.[0];
  if (
    !group ||
    !hasTags(group, p) ||
    group.VpcId !== p.vpc ||
    !group.Tags?.some((v: any) => v.Key === "Owner" && v.Value === "bob") ||
    group.IpPermissionsEgress?.some((v: any) =>
      v.IpRanges?.some((r: any) => r.CidrIp === "0.0.0.0/0"),
    )
  )
    throw Error("Bob SG ownership/egress changed");
  const table = (
    await api.call("ec2", "describe-route-tables", {
      RouteTableIds: [p.privateRouteTable],
    })
  ).RouteTables?.[0];
  if (
    !table ||
    table.VpcId !== p.vpc ||
    !table.Associations?.some((a: any) => a.Main) ||
    table.Routes?.some((r: any) => r.DestinationCidrBlock === "0.0.0.0/0")
  )
    throw Error("Reference main table/default changed");
  if (
    (
      await api.call("ec2", "describe-internet-gateways", {
        Filters: [{ Name: "attachment.vpc-id", Values: [p.vpc] }],
      })
    ).InternetGateways?.length
  )
    throw Error("Existing IGW; do not adopt");
  if (
    (
      await api.call("ec2", "describe-tags", {
        Filters: [
          { Name: "key", Values: ["DocIntelRunId"] },
          { Name: "value", Values: [p.runId] },
        ],
      })
    ).Tags?.length
  )
    throw Error("Fresh run ID already exists");
  const runtimeId = silo.runtimeArn.split("/").at(-1);
  const runtime = await api.call(
    "bedrock-agentcore-control",
    "get-agent-runtime",
    { agentRuntimeId: runtimeId },
  );
  if (
    runtime.agentRuntimeArn !== silo.runtimeArn ||
    runtime.status !== "READY" ||
    runtime.agentRuntimeVersion !== p.runtimeVersion ||
    runtime.roleArn !== p.runtimeExecutionRoleArn ||
    canonical(runtime.filesystemConfigurations) !==
      canonical([
        { sessionStorage: { mountPath: "/mnt/workspace" } },
        {
          s3FilesAccessPoint: {
            accessPointArn: p.inputAccessPointArn,
            mountPath: "/mnt/bma",
          },
        },
        {
          s3FilesAccessPoint: {
            accessPointArn: p.outputAccessPointArn,
            mountPath: "/mnt/output",
          },
        },
      ]) ||
    runtime.lifecycleConfiguration?.idleRuntimeSessionTimeout !== 28800 ||
    runtime.lifecycleConfiguration?.maxLifetime !== 28800 ||
    runtime.filesystemConfigurations?.[0]?.sessionStorage?.mountPath !==
      "/mnt/workspace" ||
    canonical(runtime.environmentVariables) !==
      canonical({
        BMA_HOME_DIR: "/mnt/workspace",
        BMA_STATE_DIR: "/mnt/workspace/.bma",
        BMA_CODEX_HOME: "/mnt/workspace/.codex",
        DISABLE_ADOT_OBSERVABILITY: "true",
        AGENT_OBSERVABILITY_ENABLED: "false",
      }) ||
    canonical(runtime.networkConfiguration?.networkModeConfig?.subnets) !==
      canonical([p.privateSubnet]) ||
    canonical(
      runtime.networkConfiguration?.networkModeConfig?.securityGroups,
    ) !== canonical([p.bobSecurityGroup])
  )
    throw Error("Official CLI stock baseline deployment not ready");
  const images = await api.call("ecr", "describe-images", {
    repositoryName: p.imageRepository,
    imageIds: [{ imageDigest: p.imageDigest }],
  });
  if (
    images.imageDetails?.length !== 1 ||
    images.imageDetails[0].imageDigest !== p.imageDigest ||
    runtime.agentRuntimeArtifact?.containerConfiguration?.containerUri !==
      `${p.account}.dkr.ecr.us-east-1.amazonaws.com/${p.imageRepository}@${p.imageDigest}`
  )
    throw Error("Image qualification identity changed");
  for (const [arn, bucket] of [
    [p.inputAccessPointArn, silo.inputBucket],
    [p.outputAccessPointArn, silo.outputBucket],
  ]) {
    const filesystemId = arn.split("/")[1],
      accessPointId = arn.split("/")[3];
    const fs = await api.call("s3files", "get-file-system", {
      fileSystemId: filesystemId,
    });
    const ap = await api.call("s3files", "get-access-point", {
      fileSystemId: filesystemId,
      accessPointId,
    });
    const own = (v: any) =>
      v.ownerId === p.account &&
      Array.isArray(v.tags) &&
      v.tags.some((t: any) => t.key === "Owner" && t.value === "bob") &&
      v.tags.some(
        (t: any) =>
          t.key === "DocIntelDeployment" && t.value === p.deploymentTag,
      );
    if (
      !own(fs) ||
      !own(ap) ||
      fs.fileSystemId !== filesystemId ||
      fs.bucket !== "arn:aws:s3:::" + bucket ||
      fs.prefix !== "" ||
      fs.status !== "available" ||
      ap.accessPointArn !== arn ||
      ap.fileSystemId !== filesystemId ||
      ap.status !== "available" ||
      ap.rootDirectory?.path !== "/"
    )
      throw Error("S3 Files owner/bucket/AP binding changed");
  }
  const policy = await api.call("iam", "get-role-policy", {
    RoleName: silo.roleArn.split("/").at(-1),
    PolicyName: p.sessionPolicyName,
  });
  if (canonical(policy.PolicyDocument) !== canonical(p.originalSessionPolicy))
    throw Error("Bob session policy changed");
  // New Bob environment only. Reconcile all list pages, not just the first page.
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let n = 0; n < 20; n++) {
    const q = new URLSearchParams({
      limit: "100",
      order: "desc",
      ...(cursor ? { after: cursor } : {}),
    });
    const { body } = await io.bma("GET", "/openai/v1/agents/sessions?" + q);
    if (!Array.isArray(body.data)) throw Error("Unknown session list");
    if (
      body.data.some(
        (s: any) =>
          s.role_arn === silo.roleArn ||
          s.environment?.runtime_arn === silo.runtimeArn,
      )
    )
      throw Error("Bob already has retained session state");
    if (body.has_more === false) break;
    if (
      body.has_more !== true ||
      !opaque(body.last_id) ||
      seen.has(body.last_id) ||
      n === 19
    )
      throw Error("Uncertain session inventory");
    seen.add(body.last_id);
    cursor = body.last_id;
  }
  j.put("preflight-passed", {
    at: c.now(),
    runtimeVersion: runtime.agentRuntimeVersion,
    imageDigest: p.imageDigest,
  });
}

export async function worker(
  p: Plan,
  j: Journal,
  io: EvidenceIo,
  api: AwsApi,
  c: Clock = clock,
) {
  if (j.read("worker-started"))
    throw Error(
      "Worker already initialized; cleanup/reconcile only, no write replay",
    );
  j.claim("worker-started", { at: c.now() });
  try {
    await preflight(p, j, api, io, c);
    await provisionNetwork(p, j, api, c);
    const silo = p.silo as any;
    await j.once("session-policy", p.proposedSessionPolicy, () => {
      admission(j, p, c, "setup");
      return api.call("iam", "put-role-policy", {
        RoleName: silo.roleArn.split("/").at(-1),
        PolicyName: p.sessionPolicyName,
        PolicyDocument: JSON.stringify(p.proposedSessionPolicy),
      });
    });
    const current = await api.call("iam", "get-role-policy", {
      RoleName: silo.roleArn.split("/").at(-1),
      PolicyName: p.sessionPolicyName,
    });
    if (
      canonical(current.PolicyDocument) !== canonical(p.proposedSessionPolicy)
    )
      throw Error("Selected-model policy not confirmed");
    return await collectBaseline(p, j, io, api, c);
  } finally {
    if (!j.read("cleanup-requested"))
      j.put("cleanup-requested", { reason: "worker-finished-or-failed" });
  }
}

export function localSourceHashes() {
  const root = new URL("../", import.meta.url);
  return Object.fromEntries(
    [
      "deployment/aws-baseline.ts",
      "deployment/http.ts",
      "deployment/baseline-fixtures/hello-bma/SKILL.md",
      "deployment/baseline-fixtures/PROVENANCE.json",
      "server/contracts.ts",
      "server/public-summaries.ts",
      "deployment/baseline-control.ts",
      "deployment/baseline-live.ts",
      "server/bedrock.ts",
      "server/sse.ts",
      "package-lock.json",
      "agentcore-reference/DocIntelReference/agentcore/cdk/lib/baseline-image-policy.proposed.ts",
      "docs/examples/network/baseline-image-digest.proposed.patch",
    ].map((name) => [name, sha(readFileSync(new URL(name, root)))]),
  );
}
export function verifyLocalInputs(plan: Plan) {
  if (
    canonical(plan.sourceSha256) !== canonical(localSourceHashes()) ||
    sha(readFileSync(plan.awsCli)) !== plan.awsCliSha256
  )
    throw Error(
      "Reviewed code or official AWS CLI hash changed; re-seal before execution",
    );
}
async function main(args: string[]) {
  if (args.length < 4 || !["check", "execute", "watchdog"].includes(args[0]))
    throw Error(
      "Use check|execute --plan PATH --approval SHA256 [--receipts PRIVATE_DIRECTORY]",
    );
  const mode = args[0];
  const pairs = args.slice(1);
  const map: Record<string, string> = {};
  if (
    pairs.length % 2 ||
    pairs.some(
      (v, i) =>
        i % 2 === 0 &&
        (!["--plan", "--approval", "--receipts"].includes(v) ||
          !!map[v] ||
          !(map[v] = pairs[i + 1])),
    )
  )
    throw Error("Invalid exact arguments");
  const bytes = readFileSync(map["--plan"]);
  const { plan, digest } = parsePlan(bytes, map["--approval"]);
  verifyLocalInputs(plan);
  if (mode === "check") {
    console.log(
      JSON.stringify({
        valid: true,
        mode: "local-check-only",
        digest,
        awsCalls: 0,
        modelCalls: 0,
        cumulativeBudgetUsd: 15,
        hardBillingCap: false,
      }),
    );
    return;
  }
  if (process.env.LIVE_AWS_CALLS !== "approved" || !map["--receipts"])
    throw Error(
      "Live execution requires separate explicit authorization and protected receipt directory",
    );
  const j = new Journal(map["--receipts"]);
  const identity = { digest: sha(canonical(plan)), runId: plan.runId };
  bindLedger(plan, identity.digest, j, mode === "execute");
  j.put("identity", identity);
  j.put("approved-plan", plan);
  const api = new OfficialAwsCli(plan);
  const io = new LiveEvidenceIo(plan, j);
  if (mode === "watchdog") {
    const lease = watchdogLease(j, clock.now);
    const interval = setInterval(() => {
      try {
        lease.renew();
        heartbeat(j, clock.now());
      } catch {
        process.exit(2);
      }
    }, 5000);
    try {
      while (clock.now() < j.read("armed").startedAt + 24 * 3600000) {
        try {
          if (await watchdogCycle(plan, j, io, api)) return;
        } catch {
          if (!j.read("cleanup-requested"))
            j.put("cleanup-requested", {
              reason: "watchdog-identity-or-api-error",
            });
          j.evidence("cleanup-watchdog-error", { at: clock.now() });
        }
        await clock.sleep(5000);
      }
      j.put("cleanup-backstop-expired", {
        at: clock.now(),
        action:
          "Manual exact-owned-resource recovery required; billing may continue",
      });
      process.exitCode = 2;
    } finally {
      clearInterval(interval);
      lease.release();
    }
  } else {
    if (j.read("armed"))
      throw Error("Existing armed run; reconcile/cleanup only");
    const releaseExecutor = j.lock("executor");
    try {
      j.claim("armed", { planSha256: identity.digest, startedAt: clock.now() });
      const saved = join(j.directory, "approved-plan.json");
      // Re-serialize exactly as the immutable receipt; its SHA must be the child approval.
      const childDigest = sha(readFileSync(saved));
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(import.meta.url),
          "watchdog",
          "--plan",
          saved,
          "--approval",
          childDigest,
          "--receipts",
          j.directory,
        ],
        { detached: true, stdio: "ignore", env: process.env },
      );
      child.unref();
      j.put("watchdog-process", { pid: child.pid });
      for (let i = 0; i < 20 && !j.read("watchdog-heartbeat"); i++)
        await clock.sleep(250);
      // Identity must remain the same exact approved bytes in both processes.
      await worker(plan, j, io, api);
    } finally {
      releaseExecutor();
    }
    console.log(
      JSON.stringify({
        baselinePassed: true,
        cleanupRequested: true,
        receipts: j.directory,
      }),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Baseline controller stopped; inspect private receipts. No automatic work replay.",
    );
    process.exitCode = 1;
  });
