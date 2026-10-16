import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { Service } from "../server/service.js";
import { Store } from "../server/store.js";
import { MockProvider } from "../server/mock.js";
const headers = { authorization: "Bearer demo-alice", host: "127.0.0.1:3000" };
const setup = async () => {
  const service = new Service(new Store(":memory:"), new MockProvider(0, 0));
  const app = await buildApp(service, {
    mode: "mock",
    origin: "http://127.0.0.1:3000",
  });
  return { app, service };
};
describe("HTTP integration", () => {
  it("returns a bounded 400 for an empty JSON mutation body", async () => {
    const { app, service } = await setup();
    const r = await app.inject({
      method: "POST",
      url: "/api/analyses/11111111-1111-4111-8111-111111111111/cancel",
      headers: { ...headers, "content-type": "application/json" },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
    service.close();
  });

  it("requires authentication and rejects cross-origin writes / hostile Host", async () => {
    const { app, service } = await setup();
    expect(
      (
        await app.inject({
          url: "/api/documents",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    const denied = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: { ...headers, origin: "https://attacker.example" },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/documents",
          headers: { ...headers, host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
    service.close();
  });
  it("exercises start, progress, result, artifacts and cross-user denial", async () => {
    const { app, service } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers,
      payload: {
        documentIds: ["acme-2024", "beta-2024"],
        question: "Compare revenue",
        requestId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(202);
    const a = res.json();
    await new Promise((r) => setTimeout(r, 5));
    await service.tick();
    const v = await app.inject({ url: `/api/analyses/${a.id}`, headers });
    expect(v.json().status).toBe("completed");
    expect(v.json().providerId).toBeUndefined();
    for (const path of [
      `/api/analyses/${a.id}`,
      `/api/analyses/${a.id}/artifacts`,
      `/api/analyses/${a.id}/artifacts/kpis.csv`,
    ])
      expect(
        (
          await app.inject({
            url: path,
            headers: { ...headers, authorization: "Bearer demo-bob" },
          })
        ).statusCode,
      ).toBe(404);
    const file = await app.inject({
      url: `/api/analyses/${a.id}/artifacts/kpis.csv`,
      headers,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.body).toContain("ACME,2024,94.2");
    await app.close();
    service.close();
  });
  it("bounds invalid request and internal error responses", async () => {
    const { app, service } = await setup();
    const r = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers,
      payload: {
        owner: "bob",
        documentIds: ["../../etc/passwd"],
        question: "short",
        requestId: randomUUID(),
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "invalid_request" });
    await app.close();
    service.close();
  });
});

it("private proxy limiter separates validated client addresses and ignores the header by default", async () => {
  for (const enabled of [true, false]) {
    const service = new Service(new Store(":memory:"), new MockProvider(0, 0));
    const app = await buildApp(service, {
      mode: "mock",
      origin: "http://127.0.0.1:3000",
      localProxyClientIp: enabled,
    });
    try {
      for (let n = 0; n < 120; n++)
        await app.inject({
          url: "/api/config",
          headers: { host: headers.host, "x-docintel-client-ip": "192.0.2.1" },
        });
      expect(
        (
          await app.inject({
            url: "/api/config",
            headers: {
              host: headers.host,
              "x-docintel-client-ip": "192.0.2.1",
            },
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await app.inject({
            url: "/api/config",
            headers: {
              host: headers.host,
              "x-docintel-client-ip": "192.0.2.2",
            },
          })
        ).statusCode,
      ).toBe(enabled ? 200 : 429);
    } finally {
      await app.close();
      service.close();
    }
  }
});
