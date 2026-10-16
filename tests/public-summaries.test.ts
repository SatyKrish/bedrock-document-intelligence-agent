import { it, expect } from "vitest";
import { extractPublicSummaries } from "../server/public-summaries.js";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockProvider } from "../server/mock.js";
import { randomUUID } from "node:crypto";
it("captures only explicit public text, deduplicates and requires owned-session assistant turn association", () => {
  const publicItem = {
    id: "reason-1",
    type: "reasoning",
    turn_id: "turn-current",
    summary: [
      { type: "summary_text", text: "Synthetic test public summary" },
      { type: "reasoning_text", text: "RAW HIDDEN MUST NOT SURVIVE" },
    ],
    encrypted_content: "ENCRYPTED MUST NOT SURVIVE",
    content: [{ text: "RAW MUST NOT SURVIVE" }],
  };
  const result = extractPublicSummaries(
    [
      publicItem,
      publicItem,
      { ...publicItem, id: "other", turn_id: "turn-other" },
      { id: "untyped", turn_id: "turn-current", summary: "untyped" },
    ],
    new Set(["turn-current"]),
  );
  expect(result).toEqual([
    {
      id: "reason-1",
      turnId: "turn-current",
      text: "Synthetic test public summary",
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/RAW|HIDDEN|ENCRYPTED/);
});
it("returns no summary for missing, unknown, malformed or oversized public envelopes", () => {
  expect(
    extractPublicSummaries(
      [
        { type: "reasoning", id: "r", turn_id: "t", text: "raw" },
        {
          type: "reasoning",
          id: "r",
          turn_id: "t",
          summary: [{ type: "summary_text", text: "x".repeat(6001) }],
        },
      ],
      new Set(["t"]),
    ),
  ).toEqual([]);
});
it("mock availability is explicit and analysis details use the same owner check", async () => {
  const s = new Service(new Store(":memory:"), new MockProvider(0, 0));
  const a = await s.start(
    { id: "alice", scopes: ["documents:read", "analysis:write"] },
    {
      documentIds: ["acme-2024"],
      question: "Analyze revenue",
      requestId: randomUUID(),
    },
  );
  expect(
    s.get({ id: "alice", scopes: ["documents:read"] }, a.id).analysisDetails
      .reasoningSummaries.status,
  ).toBe("unavailable_mock");
  expect(() => s.get({ id: "bob", scopes: ["documents:read"] }, a.id)).toThrow(
    "analysis_not_found",
  );
  await new Promise((r) => setTimeout(r, 5));
  s.close();
});

it("bounds opaque IDs and deduplicates with collision-free tuple keys", () => {
  const make = (id: string, turn: string) => ({
    id,
    type: "reasoning",
    turn_id: turn,
    summary: [{ type: "summary_text", text: "Public test summary" }],
  });
  const long = "x".repeat(1000000);
  expect(
    extractPublicSummaries(
      [make("id", long), make("", "turn")],
      new Set([long, "turn"]),
    ).length,
  ).toBe(0);
  expect(
    extractPublicSummaries(
      [make("c", "a:b"), make("b:c", "a")],
      new Set(["a:b", "a"]),
    ),
  ).toHaveLength(2);
});
it("does not expose previously stored summaries while capture is disabled", () => {
  const store = new Store(":memory:");
  const id = randomUUID();
  store.insert({
    id,
    owner: "alice",
    requestId: randomUUID(),
    documentIds: ["acme-2024"],
    question: "Analyze revenue",
    status: "completed",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    publicSummaries: [
      { id: "public-1", turnId: "turn-1", text: "Previously captured summary" },
    ],
  });
  const provider = new MockProvider();
  Object.defineProperty(provider, "mode", { value: "bedrock" });
  const service = new Service(store, provider);
  const view = service.get({ id: "alice", scopes: ["documents:read"] }, id);
  expect(view.analysisDetails.reasoningSummaries.status).toBe("disabled");
  expect(view.analysisDetails.reasoningSummaries.summaries).toEqual([]);
  expect(JSON.stringify(view)).not.toContain("Previously captured summary");
  service.close();
});
