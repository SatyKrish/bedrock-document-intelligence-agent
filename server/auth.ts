import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Principal } from "./contracts.js";
import { AppError } from "./contracts.js";
export type AuthConfig = {
  mode: "mock" | "bedrock";
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  origin: string;
  clientId?: string;
  identityOrigins?: string[];
  localProxyClientIp?: boolean;
};
export function makeAuth(c: AuthConfig, testKeySet?: JWTVerifyGetKey) {
  if (
    c.mode === "bedrock" &&
    (!c.issuer || !c.audience || !c.jwksUrl || !c.origin.startsWith("https://"))
  )
    throw new Error(
      "Live auth requires reviewed HTTPS issuer, audience, JWKS and origin",
    );
  if (c.mode === "bedrock")
    for (const value of [c.issuer!, c.jwksUrl!, c.origin, c.audience!]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw Error(
          "Live identity and resource URLs must use HTTPS without embedded credentials or fragments",
        );
    }
  const jwks =
    c.mode === "bedrock" ? createRemoteJWKSet(new URL(c.jwksUrl!)) : undefined;
  return async (header?: string): Promise<Principal> => {
    const token = header?.match(/^Bearer ([^ ]+)$/)?.[1];
    if (c.mode === "mock") {
      if (token === "demo-alice" || token === "demo-bob")
        return {
          id: token.slice(5),
          scopes: ["documents:read", "analysis:write"],
        };
      throw new AppError(401, "unauthorized");
    }
    if (!token) throw new AppError(401, "unauthorized");
    try {
      const { payload } = await jwtVerify(token, testKeySet ?? jwks!, {
        issuer: c.issuer,
        audience: c.audience,
        algorithms: ["RS256", "ES256"],
      });
      if (!payload.sub || !payload.exp) throw Error();
      const scopes =
        typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      return { id: payload.sub, scopes, expiresAt: payload.exp * 1000 };
    } catch {
      throw new AppError(401, "unauthorized");
    }
  };
}
export function requireScope(p: Principal, write = false) {
  if (!p.scopes.includes(write ? "analysis:write" : "documents:read"))
    throw new AppError(403, "insufficient_scope");
}
