import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockProvider } from "../server/mock.js";
import { validateSilos } from "../server/bedrock.js";
const alice = { id: "alice", scopes: ["documents:read", "analysis:write"] };
const bob = { ...alice, id: "bob" };
const input = () => ({
  documentIds: ["acme-2024", "beta-2024"],
  question: "Compare revenue and margins",
  requestId: randomUUID(),
});
async function settled(s: Service) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await s.tick();
  }
}
describe("shared services", () => {
  it("does not confirm cancellation after an ambiguous cancel response", async () => {
    const p = new MockProvider(10000, 0);
    vi.spyOn(p, "cancel").mockRejectedValue(Error("lost response"));
    const s = new Service(new Store(":memory:"), p);
    const a = await s.start(alice, input());
    await new Promise((r) => setTimeout(r, 5));
    await s.cancel(alice, a.id);
    await s.tick();
    expect(s.get(alice, a.id).status).toBe("cancel_requested");
    s.close();
  });

  it("bounds a stuck staging operation and keeps cancellation reachable", async () => {
    const p = new MockProvider(0, 0);
    vi.spyOn(p, "stage").mockReturnValue(new Promise(() => {}));
    const s = new Service(new Store(":memory:"), p, 10);
    const a = await s.start(alice, input());
    await new Promise((r) => setTimeout(r, 25));
    expect(s.get(alice, a.id).status).toBe("failed");
    s.close();
  });

  it("requires read and write scopes before returning cancellation state", async () => {
    const s = new Service(new Store(":memory:"), new MockProvider(10000, 0));
    const a = await s.start(alice, input());
    await new Promise((r) => setTimeout(r, 5));
    await expect(
      s.cancel({ id: "alice", scopes: ["analysis:write"] }, a.id),
    ).rejects.toThrow("insufficient_scope");
    s.close();
  });
  it("reconciles a known interrupted submission using reads only", async () => {
    const store = new Store(":memory:");
    const id = randomUUID();
    store.insert({
      id,
      owner: "alice",
      ...input(),
      providerId: "known",
      status: "submitting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const p = new MockProvider(0, 0);
    const submit = vi.spyOn(p, "submit");
    const s = new Service(store, p);
    expect(s.get(alice, id).status).toBe("reconciling");
    await s.tick();
    expect(s.get(alice, id).status).toBe("completed");
    expect(submit).not.toHaveBeenCalled();
    s.close();
  });
  it("accepts a final corrected result after an earlier command failed", async () => {
    const p = new MockProvider(0, 0);
    const poll = p.poll.bind(p);
    vi.spyOn(p, "poll").mockImplementation(async (a) => {
      const v = await poll(a);
      v.items.unshift({ id: "earlier-command", exit_code: 1 });
      return v;
    });
    const s = new Service(new Store(":memory:"), p);
    const a = await s.start(alice, input());
    await settled(s);
    expect(s.get(alice, a.id).status).toBe("completed");
    s.close();
  });

  it("enforces catalog and session ownership", async () => {
    const s = new Service(new Store(":memory:"), new MockProvider(0, 0));
    expect(s.docs(bob).map((d) => d.id)).toEqual(["acme-2024"]);
    await expect(s.start(bob, input())).rejects.toThrow("document_not_found");
    const a = await s.start(alice, input());
    expect(() => s.get(bob, a.id)).toThrow("analysis_not_found");
    await expect(s.cancel(bob, a.id)).rejects.toThrow("analysis_not_found");
    await expect(s.download(bob, a.id, "comparison.md")).rejects.toThrow(
      "analysis_not_found",
    );
    s.close();
  });
  it("deduplicates requests and rejects reused keys with changed input", async () => {
    const s = new Service(new Store(":memory:"), new MockProvider(0, 0));
    const args = input();
    const a = await s.start(alice, args);
    expect((await s.start(alice, args)).id).toBe(a.id);
    await expect(
      s.start(alice, { ...args, question: "Different request" }),
    ).rejects.toThrow("request_id_conflict");
    await settled(s);
    expect(s.get(alice, a.id).status).toBe("completed");
    s.close();
  });
  it("keeps downloads unavailable until output synchronization and seals bytes", async () => {
    const p = new MockProvider(0, 10000);
    const s = new Service(new Store(":memory:"), p);
    const a = await s.start(alice, input());
    await settled(s);
    expect(s.get(alice, a.id).status).toBe("syncing");
    expect(s.artifacts(alice, a.id).artifacts).toEqual([]);
    await expect(s.download(alice, a.id, "kpis.csv")).rejects.toThrow(
      "artifact_not_available",
    );
    s.close();
  });
  it("completes cited output and refuses post-completion mutation", async () => {
    const p = new MockProvider(0, 0);
    const s = new Service(new Store(":memory:"), p);
    const a = await s.start(alice, input());
    await settled(s);
    const v = s.get(alice, a.id);
    expect(v.result?.citations).toHaveLength(2);
    expect(v.status).toBe("completed");
    expect((await s.download(alice, a.id, "kpis.csv")).toString()).toContain(
      "94.2",
    );
    vi.spyOn(p, "artifact").mockResolvedValue(Buffer.from("changed"));
    await expect(s.download(alice, a.id, "kpis.csv")).rejects.toThrow(
      "artifact_changed_or_unavailable",
    );
    s.close();
  });
  it("does not interpret missing values as EBITDA", async () => {
    const s = new Service(new Store(":memory:"), new MockProvider(0, 0));
    const a = await s.start(alice, input());
    await settled(s);
    expect(s.get(alice, a.id).result?.answer).toContain(
      "EBITDA is not disclosed",
    );
    s.close();
  });
  it("requests and confirms cancellation", async () => {
    const s = new Service(new Store(":memory:"), new MockProvider(10000, 0));
    const a = await s.start(alice, input());
    await new Promise((r) => setTimeout(r, 5));
    expect((await s.cancel(alice, a.id)).status).toBe("cancel_requested");
    await s.tick();
    expect(s.get(alice, a.id).status).toBe("cancelled");
    s.close();
  });
  it("never automatically replays an ambiguous submit", async () => {
    const p = new MockProvider(0, 0);
    const submit = vi
      .spyOn(p, "submit")
      .mockRejectedValue(Error("lost response"));
    const store = new Store(":memory:");
    const s = new Service(store, p);
    const a = await s.start(alice, input());
    await settled(s);
    expect(["reconciling", "completed"]).toContain(s.get(alice, a.id).status);
    await s.tick();
    expect(submit).toHaveBeenCalledTimes(1);
    s.close();
  });
  it("recovers running rows and marks interrupted writes uncertain", () => {
    const store = new Store(":memory:");
    for (const status of ["running", "creating", "submitting"] as const)
      store.insert({
        id: randomUUID(),
        owner: "alice",
        ...input(),
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    const s = new Service(store, new MockProvider(0, 0));
    expect(s.list(alice).map((a) => a.status)).toEqual([
      "running",
      "uncertain",
      "uncertain",
    ]);
    s.close();
  });
  it("rejects quoted spreadsheet formulas", async () => {
    const p = new MockProvider(0, 0);
    const artifact = p.artifact.bind(p);
    vi.spyOn(p, "artifact").mockImplementation((a, n) =>
      n === "kpis.csv"
        ? Promise.resolve(
            Buffer.from(
              'company,fiscal_year,revenue_usd_billions,operating_income_usd_billions,source_document,source_section\n"=1+1",2024,94.2,21.6,acme-2024,Financial performance\n',
            ),
          )
        : artifact(a, n),
    );
    const s = new Service(new Store(":memory:"), p);
    const a = await s.start(alice, input());
    await settled(s);
    expect(s.get(alice, a.id).status).toBe("failed");
    s.close();
  });
  it("rejects unsupported KPI numbers despite a valid citation", async () => {
    const p = new MockProvider(0, 0);
    const artifact = p.artifact.bind(p);
    vi.spyOn(p, "artifact").mockImplementation(async (a, n) => {
      const b = await artifact(a, n);
      return n === "kpis.csv"
        ? Buffer.from(b!.toString().replace("94.2", "999999"))
        : b;
    });
    const s = new Service(new Store(":memory:"), p);
    const a = await s.start(alice, input());
    await settled(s);
    expect(s.get(alice, a.id).status).toBe("failed");
    s.close();
  });
  it("rejects overlapping input and output buckets across principals", () => {
    const make = (name: string) => ({
      region: "us-east-1",
      runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}`,
      roleArn: `arn:aws:iam::123456789012:role/${name}`,
      applicationRoleArn: `arn:aws:iam::123456789012:role/app-${name}`,
      model: "openai.gpt-5.6-luna",
      inputBucket: name + "-input",
      outputBucket: name + "-output",
    });
    expect(() =>
      validateSilos({
        alice: make("alice"),
        bob: { ...make("bob"), outputBucket: "alice-input" },
      }),
    ).toThrow();
  });
});
