import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { configureCatalog } from "./catalog.js";
import { MockProvider } from "./mock.js";
import { BedrockProvider, validateSilos } from "./bedrock.js";
const mode = process.env.MODE ?? "mock";
if (mode !== "mock" && mode !== "bedrock")
  throw Error("MODE must be mock or bedrock");
if (mode === "bedrock" && process.env.LIVE_AWS_CALLS !== "approved")
  throw Error(
    "Live mode disabled: follow docs/deployment.md and explicitly set LIVE_AWS_CALLS=approved only after authorization",
  );
const port = Number(process.env.PORT ?? 3000);
const origin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const provider =
  mode === "mock"
    ? new MockProvider()
    : new BedrockProvider(
        validateSilos(
          JSON.parse(readFileSync(process.env.SILOS_FILE!, "utf8")),
        ),
        fetch,
        undefined,
        process.env.BMA_PUBLIC_SUMMARIES === "conservative-preview",
      );
if (mode === "bedrock")
  configureCatalog(
    JSON.parse(readFileSync(process.env.CATALOG_ACL_FILE!, "utf8")),
  );
const host = process.env.HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "0.0.0.0")
  throw Error("Unsupported listener host");
const service = new Service(
  new Store(process.env.STATE_FILE ?? resolve(".state", mode + ".sqlite")),
  provider,
);
const app = await buildApp(service, {
  mode,
  origin,
  localProxyClientIp: process.env.LOCAL_PROXY_CLIENT_IP === "enabled",
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE,
  jwksUrl: process.env.OIDC_JWKS_URL,
  clientId: process.env.OIDC_CLIENT_ID,
  identityOrigins: process.env.OIDC_CONNECT_ORIGINS?.split(","),
});
const timer = setInterval(() => {
  void service.tick().catch(() => {});
}, 1000);
await app.listen({ port, host });
console.error(`Document Intelligence: ${origin} (${mode}; local listener)`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    clearInterval(timer);
    void app.close().then(() => {
      service.close();
      process.exit(0);
    });
  });
