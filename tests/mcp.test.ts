import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../server/app.js";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockProvider } from "../server/mock.js";
import { randomUUID } from "node:crypto";
it("dogfoods official MCP SDK discovery, authorized analysis/result/artifact tools and isolation", async () => {
  const service = new Service(new Store(":memory:"), new MockProvider(0, 0));
  const app = await buildApp(service, {
    mode: "mock",
    origin: "http://127.0.0.1",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const make = async (token: string) => {
    const c = new Client({ name: "local-contract-test", version: "0.1.0" });
    await c.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      ),
    );
    return c;
  };
  const alice = await make("demo-alice");
  const bob = await make("demo-bob");
  try {
    const tools = (await alice.listTools()).tools;
    expect(tools).toHaveLength(7);
    expect(
      tools.find((t) => t.name === "start_analysis")?.annotations?.readOnlyHint,
    ).toBe(false);
    const docs = await bob.callTool({ name: "list_documents", arguments: {} });
    expect(JSON.stringify(docs)).not.toContain("beta-2024");
    const start = await alice.callTool({
      name: "start_analysis",
      arguments: {
        documentIds: ["acme-2024", "beta-2024"],
        question: "Compare revenue",
        requestId: randomUUID(),
      },
    });
    const id = (start.structuredContent as any).data.analysis.id;
    await new Promise((r) => setTimeout(r, 5));
    await service.tick();
    const result = await alice.callTool({
      name: "get_analysis",
      arguments: { analysisId: id },
    });
    expect((result.structuredContent as any).data.analysis.status).toBe(
      "completed",
    );
    const artifact = await alice.callTool({
      name: "get_artifact",
      arguments: { analysisId: id, name: "kpis.csv" },
    });
    expect(JSON.stringify(artifact)).toContain("ACME,2024,94.2");
    const denied = await bob.callTool({
      name: "get_analysis",
      arguments: { analysisId: id },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("analysis_not_found");
  } finally {
    await alice.close();
    await bob.close();
    await app.close();
    service.close();
  }
});
