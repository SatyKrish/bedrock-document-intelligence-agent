import { it, expect } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { makeAuth, requireScope } from "../server/auth.js";
const config = {
  mode: "bedrock" as const,
  origin: "https://app.example",
  issuer: "https://id.example",
  audience: "https://app.example/mcp",
  jwksUrl: "https://id.example/jwks",
};
it("rejects HTTP issuer/JWKS and missing live auth configuration without networking", () => {
  for (const field of ["issuer", "jwksUrl", "origin", "audience"] as const)
    expect(() =>
      makeAuth({ ...config, [field]: "http://unsafe.example" }),
    ).toThrow();
  expect(() => makeAuth({ mode: "bedrock", origin: config.origin })).toThrow();
});
it("verifies signatures, issuer, resource audience, expiry and scopes locally", async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test-key";
  const auth = makeAuth(config, createLocalJWKSet({ keys: [jwk] }));
  const mint = (aud = config.audience, exp = "5m") =>
    new SignJWT({ scope: "documents:read" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setSubject("alice")
      .setIssuer(config.issuer)
      .setAudience(aud)
      .setExpirationTime(exp)
      .sign(keys.privateKey);
  const p = await auth("Bearer " + (await mint()));
  expect(p.id).toBe("alice");
  expect(() => requireScope(p, true)).toThrow("insufficient_scope");
  await expect(
    auth("Bearer " + (await mint("https://other.example"))),
  ).rejects.toThrow("unauthorized");
  await expect(
    auth("Bearer " + (await mint(config.audience, "-1s"))),
  ).rejects.toThrow("unauthorized");
  await expect(auth("Bearer forged")).rejects.toThrow("unauthorized");
});
