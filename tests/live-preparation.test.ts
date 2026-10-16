import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Configuration } from "../deployment/config.js";
import { sealPlan } from "../deployment/approval.js";
import { sourceInventory } from "../deployment/source.js";
import { authorizeReadback } from "../deployment/live-readback.js";
const c = Configuration.parse({
  ...JSON.parse(readFileSync("deploy/config.example.json", "utf8")),
  termsReviewed: true,
  principals: [
    {
      subject: "synthetic-alice",
      documents: ["acme-2024", "beta-2024", "kpis-2024"],
    },
    { subject: "synthetic-bob", documents: ["acme-2024"] },
  ],
});
const cases = {
  version: 1,
  syntheticOnly: true,
  summaries: "disabled",
  cases: [
    {
      subject: "synthetic-alice",
      analysisId: "11111111-1111-4111-8111-111111111111",
      sessionId: "owned-alice",
      tokenEnvironment: "DOCINTEL_ACCEPTANCE_ALICE_TOKEN",
    },
    {
      subject: "synthetic-bob",
      analysisId: "22222222-2222-4222-8222-222222222222",
      sessionId: "owned-bob",
      tokenEnvironment: "DOCINTEL_ACCEPTANCE_BOB_TOKEN",
    },
  ],
};
const plan = () =>
  sealPlan({
    version: 1,
    phase: "deploy",
    configuration: c,
    sourceDigest: sourceInventory().digest,
    templates: {},
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    retainData: true,
    costAllowanceUsd: 5,
  });
it("real acceptance rejects missing/wrong approval before credentials or HTTP can be used", () => {
  const p = plan();
  expect(() => authorizeReadback(c, p, "wrong", cases)).toThrow("Approval");
  expect(authorizeReadback(c, p, p.id, cases).cases).toHaveLength(2);
});
it("real acceptance requires two distinct configured synthetic owners and session cases", () => {
  const p = plan();
  expect(() =>
    authorizeReadback(c, p, p.id, { ...cases, syntheticOnly: false }),
  ).toThrow();
  expect(() =>
    authorizeReadback(c, p, p.id, {
      ...cases,
      cases: [cases.cases[0], cases.cases[0]],
    }),
  ).toThrow("distinct");
  expect(() =>
    authorizeReadback(c, p, p.id, {
      ...cases,
      cases: [cases.cases[0], { ...cases.cases[1], subject: "unapproved" }],
    }),
  ).toThrow("approved");
});
