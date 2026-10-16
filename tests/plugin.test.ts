import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildApp } from "../server/app.js";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockProvider } from "../server/mock.js";
import { resolve } from "node:path";

it("starts the packaged stdio bridge and calls the same authorized HTTP MCP service", async () => {
  const service = new Service(new Store(":memory:"), new MockProvider(0, 0));
  const app = await buildApp(service, {
    mode: "mock",
    origin: "http://127.0.0.1",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const client = new Client({ name: "plugin-source-test", version: "0.1.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("plugin/document-intelligence/server/bridge.mjs")],
        env: {
          DOCINTEL_URL: `http://127.0.0.1:${port}/mcp`,
          DOCINTEL_TOKEN: "demo-bob",
        },
        stderr: "pipe",
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(7);
    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    expect(JSON.stringify(result)).toContain("acme-2024");
    expect(JSON.stringify(result)).not.toContain("beta-2024");
  } finally {
    await client.close();
    await app.close();
    service.close();
  }
});
