import Fastify from "fastify";
import { isIP } from "node:net";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { AppError } from "./contracts.js";
import { makeAuth, type AuthConfig } from "./auth.js";
import { Service } from "./service.js";
import { createMcp } from "./mcp.js";
export async function buildApp(service: Service, config: AuthConfig) {
  const identityOrigins =
    config.mode === "bedrock"
      ? (config.identityOrigins ?? []).map((value) => {
          const u = new URL(value);
          if (u.protocol !== "https:" || u.origin !== value)
            throw Error(
              "Identity connect origins must be canonical HTTPS origins",
            );
          return u.origin;
        })
      : [];
  const app = Fastify({
    logger: false,
    bodyLimit: 32768,
    requestTimeout: 30000,
  });
  const auth = makeAuth(config);
  const challenge = `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource", scope="documents:read analysis:write"`;
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Enabled only with the private localhost proxy topology. Nginx overwrites this header.
      const ip = req.headers["x-docintel-client-ip"];
      return config.localProxyClientIp && typeof ip === "string" && isIP(ip)
        ? ip
        : req.ip;
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${identityOrigins.join(" ")}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`,
      );
    if (req.headers.origin && req.headers.origin !== config.origin)
      throw new AppError(403, "origin_rejected");
    const host = req.headers.host?.split(":")[0];
    if (config.mode === "mock" && host !== "127.0.0.1" && host !== "localhost")
      throw new AppError(403, "host_rejected");
  });
  app.setErrorHandler((err, req, reply) => {
    const status =
      err instanceof AppError
        ? err.status
        : err instanceof ZodError
          ? 400
          : [400, 413, 415, 429].includes(
                (err as { statusCode?: number }).statusCode ?? 0,
              )
            ? (err as { statusCode: number }).statusCode
            : 500;
    if (status === 401) reply.header("WWW-Authenticate", challenge);
    reply.status(status).send({
      error:
        err instanceof AppError
          ? err.code
          : status === 400
            ? "invalid_request"
            : status === 429
              ? "rate_limited"
              : "internal_error",
    });
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/config", async () => ({
    mode: config.mode,
    ...(config.mode === "bedrock" && config.clientId
      ? {
          identity: {
            issuer: config.issuer,
            clientId: config.clientId,
            audience: config.audience,
            redirectUri: config.origin + "/",
          },
        }
      : {}),
  }));
  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: config.audience ?? config.origin + "/mcp",
    authorization_servers: config.issuer ? [config.issuer] : [],
    scopes_supported: ["documents:read", "analysis:write"],
  }));
  app.get("/api/documents", async (req) => ({
    documents: service.docs(await auth(req.headers.authorization)),
  }));
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req) =>
    service.readDoc(await auth(req.headers.authorization), req.params.id),
  );
  app.get("/api/analyses", async (req) => ({
    analyses: service.list(await auth(req.headers.authorization)),
  }));
  app.post("/api/analyses", async (req, reply) => {
    const a = await service.start(
      await auth(req.headers.authorization),
      req.body,
    );
    reply.code(202);
    return a;
  });
  app.get<{ Params: { id: string } }>("/api/analyses/:id", async (req) =>
    service.get(await auth(req.headers.authorization), req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/analyses/:id/cancel",
    async (req) =>
      service.cancel(await auth(req.headers.authorization), req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/analyses/:id/artifacts",
    async (req) =>
      service.artifacts(await auth(req.headers.authorization), req.params.id),
  );
  app.get<{ Params: { id: string; name: string } }>(
    "/api/analyses/:id/artifacts/:name",
    async (req, reply) => {
      const b = await service.download(
        await auth(req.headers.authorization),
        req.params.id,
        req.params.name,
      );
      reply
        .header(
          "Content-Disposition",
          `attachment; filename="${req.params.name}"`,
        )
        .type(
          req.params.name.endsWith("csv")
            ? "text/csv; charset=utf-8"
            : "text/markdown; charset=utf-8",
        );
      return reply.send(b);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/analyses/:id/events",
    async (req, reply) => {
      const p = await auth(req.headers.authorization);
      service.get(p, req.params.id);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      let seq = 0;
      let last = "";
      const send = () => {
        try {
          const v = service.get(p, req.params.id);
          const text = JSON.stringify(v);
          if (text !== last) {
            reply.raw.write(`id: ${++seq}\nevent: snapshot\ndata: ${text}\n\n`);
            last = text;
          } else reply.raw.write(": heartbeat\n\n");
        } catch {
          reply.raw.end();
        }
      };
      send();
      const t = setInterval(send, 1000);
      const expiry = setTimeout(
        () => reply.raw.end(),
        Math.max(
          0,
          Math.min(60000, (p.expiresAt ?? Date.now() + 60000) - Date.now()),
        ),
      );
      reply.raw.on("close", () => {
        clearInterval(t);
        clearTimeout(expiry);
      });
    },
  );
  app.post("/mcp", async (req, reply) => {
    const p = await auth(req.headers.authorization);
    const server = createMcp(service, p);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.route({
    method: ["GET", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      await auth(req.headers.authorization);
      reply.status(405).send({ error: "stateless_mcp_post_required" });
    },
  });
  const root = resolve("dist/web");
  if (existsSync(root)) await app.register(staticFiles, { root });
  return app;
}
