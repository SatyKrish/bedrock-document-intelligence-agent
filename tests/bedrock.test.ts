import { it, expect } from "vitest";
import { BedrockProvider, validateSilos } from "../server/bedrock.js";
import type { Analysis } from "../server/contracts.js";
import { documents } from "../server/catalog.js";
const a: Analysis = {
  id: "11111111-1111-4111-8111-111111111111",
  owner: "alice",
  requestId: "22222222-2222-4222-8222-222222222222",
  documentIds: ["acme-2024"],
  question: "Analyze revenue",
  status: "running",
  createdAt: 0,
  updatedAt: 0,
  providerId: "sess/a?b",
};
const silos = validateSilos({
  alice: {
    region: "us-east-1",
    runtimeArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/alice",
    roleArn: "arn:aws:iam::123456789012:role/alice",
    applicationRoleArn: "arn:aws:iam::123456789012:role/app-alice",
    inputBucket: "alice-input",
    outputBucket: "alice-output",
    model: "openai.gpt-5.6-luna",
  },
});
const credential = async () => ({
  accessKeyId: "SYNTHETIC_TEST_ACCESS",
  secretAccessKey: "synthetic-test-secret",
  sessionToken: "synthetic-session-token",
});
it("signs raw documented REST and handles empty acceptance / cancellation without replay", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(
      init?.method === "POST" && String(url).endsWith("/sessions")
        ? JSON.stringify({ id: "sess_created", object: "agent.session" })
        : null,
      { status: 200 },
    );
  }) as typeof fetch;
  const p = new BedrockProvider(silos, fetcher, credential);
  expect(await p.create(a)).toBe("sess_created");
  await p.submit(a, [documents[0]]);
  await p.cancel(a);
  expect(calls).toHaveLength(3);
  const h = calls[0].init.headers as Record<string, string>;
  expect(h.authorization).toContain("/us-east-1/bedrock-mantle/aws4_request");
  expect(h["x-amzn-account-id"]).toBe("123456789012");
  expect(h.authorization).toContain("x-amzn-account-id");
  expect(h["x-amz-security-token"]).toBe("synthetic-session-token");
  const create = JSON.parse(calls[0].init.body as string);
  expect(create.environment.type).toBe("aws_bedrock_agentcore");
  expect(create.environment.workspace_directory).toBe("/mnt/home/workspace");
  expect(create.environment.capability_directories).toEqual([
    "/opt/bma/plugins",
  ]);
  expect(create).not.toHaveProperty("messages");
  expect(create.role_arn).toBe(silos.alice.roleArn);
  expect(calls[1].url).toContain("sess%2Fa%3Fb/events");
  expect(JSON.parse(calls[1].init.body as string).events[0].type).toBe(
    "agent.session.input.message",
  );
  expect(JSON.parse(calls[2].init.body as string)).toEqual({
    events: [{ type: "agent.session.input.cancel" }],
  });
});
it("encodes opaque pagination and tolerates extra item fields", async () => {
  const urls: string[] = [];
  const fetcher = (async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify(
        urls.length === 1
          ? { status: "in_progress" }
          : urls.length === 2
            ? {
                data: [{ id: "item-1", type: "unknown", extra: true }],
                has_more: true,
                last_id: "cursor/a?&",
              }
            : {
                data: [{ id: "item-2", role: "assistant", turn_id: "opaque" }],
                has_more: false,
                last_id: "item-2",
              },
      ),
    );
  }) as typeof fetch;
  const p = new BedrockProvider(silos, fetcher, credential);
  expect((await p.poll(a)).items).toHaveLength(2);
  expect(new URL(urls[2]).searchParams.get("after")).toBe("cursor/a?&");
});
it("does not retry ambiguous non-idempotent network writes", async () => {
  let count = 0;
  const p = new BedrockProvider(
    silos,
    (async () => {
      count++;
      throw Error("lost response");
    }) as typeof fetch,
    credential,
  );
  await expect(p.submit(a, [documents[0]])).rejects.toThrow("lost response");
  expect(count).toBe(1);
});

it("requests the stock CLI event-stream query and signs the opaque session path", async () => {
  const ctl = new AbortController();
  const urls: string[] = [];
  const p = new BedrockProvider(
    silos,
    (async (url) => {
      urls.push(String(url));
      return new Response('data: {"type":"agent.session.created"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
    credential,
  );
  await p.watch(a, () => ctl.abort(), ctl.signal);
  expect(urls).toHaveLength(1);
  expect(new URL(urls[0]).searchParams.get("stream")).toBe("true");
  expect(new URL(urls[0]).pathname).toContain("sess%2Fa%3Fb/events");
});
