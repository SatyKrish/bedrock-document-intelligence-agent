import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  baselineProfile,
  baselineSession,
  baselineEvent,
  baselineModel,
  baselineSkillBytes,
  baselineSkillSha256,
  verifyHello,
  verifyBaselineOutput,
  baselineCost,
} from "../deployment/aws-baseline.js";
const project = JSON.parse(
  readFileSync(
    "agentcore-reference/DocIntelReference/agentcore/agentcore.json",
    "utf8",
  ),
);
const silo = {
  region: "us-east-1",
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/Bob",
  roleArn: "arn:aws:iam::123456789012:role/bob-session",
  applicationRoleArn: "arn:aws:iam::123456789012:role/bob-app",
  inputBucket: "bob-input",
  outputBucket: "bob-output",
  model: baselineModel,
};
it("baseline profile preserves the other owner and every image/build/network identity", () => {
  const before = structuredClone(project),
    copy = baselineProfile(project, "Bob");
  expect(project).toEqual(before);
  expect(copy.runtimes[0]).toEqual(project.runtimes[0]);
  const old = project.runtimes[1],
    changed = copy.runtimes[1];
  for (const k of [
    "name",
    "codeLocation",
    "dockerfile",
    "build",
    "networkConfig",
    "executionRoleArn",
  ])
    expect(changed[k]).toEqual(old[k]);
  expect(changed.lifecycleConfiguration).toEqual({
    idleRuntimeSessionTimeout: 28800,
    maxLifetime: 28800,
  });
  expect(changed.filesystemConfigurations[0].sessionStorage.mountPath).toBe(
    "/mnt/workspace",
  );
  expect(changed.filesystemConfigurations.slice(1)).toEqual(
    old.filesystemConfigurations.slice(1),
  );
  expect(() => baselineProfile(project, "Unknown")).toThrow();
});
it("stock session and two text events contain no document product tools or unsupported settings", () => {
  const request = baselineSession(silo);
  expect(request.agent.model).toBe(baselineModel);
  expect(request.agent).not.toHaveProperty("tools");
  expect(request.environment.workspace_directory).toBe("/mnt/workspace");
  expect(request.role_arn).toBe(silo.roleArn);
  expect(request.stream).toBe(false);
  expect(() =>
    baselineSession({
      ...silo,
      runtimeArn: silo.runtimeArn.replace("us-east-1", "us-west-2"),
    }),
  ).toThrow();
  expect(() =>
    baselineSession({
      ...silo,
      roleArn: silo.roleArn.replace("123456789012", "999999999999"),
    }),
  ).toThrow();
  expect(() =>
    baselineSession({ ...silo, inputBucket: silo.outputBucket }),
  ).toThrow();
  expect(baselineEvent(0).events[0].input[0].content[0].text).toContain(
    "hello-bma",
  );
  expect(baselineEvent(1).events[0].input[0].content[0].text).toContain(
    "/mnt/output/verification.txt",
  );
  expect(() =>
    baselineSession({ ...silo, model: "openai.gpt-6-luna" }),
  ).toThrow();
});
it("requires successful actual command evidence rather than idle or narrative claims", () => {
  const item = (command: string, output: string, exit_code = 0) => ({
    type: "command_execution",
    command,
    output,
    exit_code,
  });
  const good = [
    item(
      "sha256sum /mnt/bma/skills/hello-bma/SKILL.md",
      baselineSkillSha256 + "  /mnt/bma/skills/hello-bma/SKILL.md",
    ),
    item(
      "sha256sum /mnt/workspace/skills/hello-bma/SKILL.md",
      baselineSkillSha256 + "  /mnt/workspace/skills/hello-bma/SKILL.md",
    ),
    item("cat /mnt/workspace/skills/hello-bma/SKILL.md | head -1", "---\n"),
    item("ls /mnt/workspace/skills", "hello-bma\n"),
  ];
  expect(verifyHello(good).stage).toBe("hello-bma");
  expect(() => verifyHello([])).toThrow();
  expect(() =>
    verifyHello([{ role: "assistant", content: "It worked" }]),
  ).toThrow();
  expect(() =>
    verifyHello(good.map((x) => ({ ...x, exit_code: 1 }))),
  ).toThrow();
  expect(() => verifyHello(good.slice(1))).toThrow();
  expect(() =>
    verifyHello(
      good.map((x) => ({ ...x, command: "echo '" + x.command + "'" })),
    ),
  ).toThrow();
  expect(() =>
    verifyHello(
      good.map((x) => ({ ...x, command: x.command + "; echo forged" })),
    ),
  ).toThrow();
  expect(() =>
    verifyHello(
      good.map((x) => ({
        ...x,
        output: x.output.replace("  /mnt/bma/", "  /other/"),
      })),
    ),
  ).toThrow();
});
it("S3 output acceptance requires fresh same-version available bytes and metadata", () => {
  const bytes = Buffer.from("BMA_OUTPUT_VERIFIED\n");
  const head = { contentLength: bytes.length, etag: "etag", versionId: "v1" };
  const get = { etag: "etag", versionId: "v1", preTurnOutputAbsent: true };
  expect(verifyBaselineOutput(bytes, head, get).sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(() =>
    verifyBaselineOutput(Buffer.from("model said success"), head, get),
  ).toThrow();
  expect(() =>
    verifyBaselineOutput(bytes, { ...head, contentLength: 0 }, get),
  ).toThrow();
  expect(() =>
    verifyBaselineOutput(bytes, { ...head, etag: "" }, get),
  ).toThrow();
  expect(() =>
    verifyBaselineOutput(bytes, head, { ...get, preTurnOutputAbsent: false }),
  ).toThrow();
  expect(() =>
    verifyBaselineOutput(bytes, head, { ...get, versionId: "old" }),
  ).toThrow();
  expect(() =>
    verifyBaselineOutput(bytes, head, { ...get, etag: "changed" }),
  ).toThrow();
  expect(() =>
    verifyBaselineOutput(
      bytes,
      { ...head, versionId: undefined },
      { ...get, versionId: undefined },
    ),
  ).toThrow();
});
it("stock hello-bma bytes and provenance match and cost includes prior work plus cleanup-failure exposure", () => {
  const provenance = JSON.parse(
    readFileSync("deployment/baseline-fixtures/PROVENANCE.json", "utf8"),
  );
  expect(createHash("sha256").update(baselineSkillBytes).digest("hex")).toBe(
    provenance.skillSha256,
  );
  const cost = baselineCost();
  expect(cost.requestedCumulativeBudgetUsd).toBe(15);
  expect(cost.priorReservationCarriedForward).toBe(4.594);
  expect(cost.newBuildsKeysImages).toBe(0);
  expect(cost.billingCapEnforced).toBe(false);
  expect(cost.totalReserved).toBe(15);
  expect(cost.unallocatedContingency).toBeGreaterThan(0);
  expect(cost.failureScenarioLimits).toContain(
    "not an overall session/spend cap",
  );
});
