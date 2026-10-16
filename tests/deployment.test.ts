import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Configuration } from "../deployment/config.js";
import { createPlan } from "../deployment/planner.js";
import {
  verifyPlan,
  canonical,
  sealPlan,
  digest,
} from "../deployment/approval.js";
import { sourceInventory, ROOT, packageSource } from "../deployment/source.js";
import { applyPlan } from "../deployment/apply.js";
import { cleanupPlan, cleanup } from "../deployment/cleanup.js";
import { hostUserData } from "../deployment/host-user-data.js";
const c = Configuration.parse({
  ...JSON.parse(readFileSync(join(ROOT, "deploy/config.example.json"), "utf8")),
  termsReviewed: true,
});
it("seals source/config/templates and rejects wrong, stale and changed approvals before AWS calls", async () => {
  const p = createPlan(c, "build");
  expect(() => verifyPlan(p, p.id, c, sourceInventory().digest)).not.toThrow();
  expect(() => verifyPlan(p, "incorrect", c, p.sourceDigest)).toThrow(
    "Approval",
  );
  expect(() =>
    verifyPlan(p, p.id, { ...c, account: "000000000000" }, p.sourceDigest),
  ).toThrow("changed");
  expect(() => verifyPlan(p, p.id, c, "changed-source")).toThrow("changed");
  const stale = sealPlan({ ...p, expiresAt: "2000-01-01T00:00:00Z" });
  expect(() => verifyPlan(stale, stale.id, c, p.sourceDigest)).toThrow();
  let calls = 0;
  await expect(
    applyPlan(c, p, "bad", {
      call() {
        calls++;
        return {};
      },
    }),
  ).rejects.toThrow("Approval");
  expect(calls).toBe(0);
});
it("synthesizes a scoped non-VPC ARM builder with no model/deployment grant", () => {
  const p = createPlan(c, "build"),
    text = JSON.stringify(p.templates);
  expect(text).toContain("ARM_CONTAINER");
  expect(text).toContain("BUILD_GENERAL1_SMALL");
  expect(text).toContain('"PrivilegedMode":false');
  expect(text).toContain('"TimeoutInMinutes":30');
  expect(text).toContain('"ConcurrentBuildLimit":1');
  expect(text).not.toContain("bedrock-mantle:");
  expect(text).not.toContain("iam:PassRole");
  expect(text).not.toContain("cloudformation:");
  expect(text).toContain("ecr:PutImage");
  expect(text).toContain(`/source/${p.sourceDigest}.zip`);
  expect(text).not.toContain("AWS::EC2::NatGateway");
});
it("plans hosted runtime and application with retained encrypted state, scoped identities and CFN config references", () => {
  const source = sourceInventory().digest;
  const p = createPlan(c, "deploy", {
    sourceDigest: source,
    runtime: "sha256:" + "a".repeat(64),
    app: "sha256:" + "b".repeat(64),
  });
  const resources = Object.values(p.templates).flatMap((t: any) =>
    Object.values(t.Resources),
  ) as any[];
  expect(
    resources.filter((r) => r.Type === "AWS::EC2::NatGateway"),
  ).toHaveLength(1);
  expect(
    resources.filter((r) => r.Type === "AWS::S3Files::FileSystem"),
  ).toHaveLength(2);
  expect(
    resources.filter((r) => r.Type === "AWS::Lambda::Function"),
  ).toHaveLength(0);
  const volume = resources.find((r) => r.Type === "AWS::EC2::Volume");
  expect(volume.DeletionPolicy).toBe("Retain");
  expect(volume.Properties.Encrypted).toBe(true);
  const parameter = resources.find((r) => r.Type === "AWS::SSM::Parameter");
  expect(JSON.stringify(parameter)).toContain("Fn::ImportValue");
  expect(JSON.stringify(parameter)).not.toContain("RESOLVED_AFTER");
  const instance = resources.find((r) => r.Type === "AWS::EC2::Instance");
  expect(instance.Properties.MetadataOptions.HttpTokens).toBe("required");
  expect(instance.Properties.MetadataOptions.HttpPutResponseHopLimit).toBe(2);
  const listener = resources.find(
    (r) => r.Type === "AWS::ElasticLoadBalancingV2::Listener",
  );
  expect(listener.Properties.Protocol).toBe("HTTPS");
  expect(JSON.stringify(p.templates)).not.toContain("AWS::Cognito");
});
it("developer and imported-network mode omit hosted/public/new-network resources", () => {
  const network = {
    kind: "existing",
    vpcId: "vpc-00000000000000000",
    vpcCidr: "10.0.0.0/16",
    privateSubnets: [
      {
        subnetId: "subnet-11111111111111111",
        routeTableId: "rtb-11111111111111111",
        availabilityZone: "us-east-1a",
      },
      {
        subnetId: "subnet-22222222222222222",
        routeTableId: "rtb-22222222222222222",
        availabilityZone: "us-east-1b",
      },
    ],
    publicSubnets: [
      {
        subnetId: "subnet-33333333333333333",
        routeTableId: "rtb-33333333333333333",
        availabilityZone: "us-east-1a",
      },
      {
        subnetId: "subnet-44444444444444444",
        routeTableId: "rtb-44444444444444444",
        availabilityZone: "us-east-1b",
      },
    ],
  };
  const dev = Configuration.parse({
    ...c,
    mode: "developer",
    developerCallerArn: "arn:aws:iam::123456789012:role/approved-dev",
    network,
  });
  const p = createPlan(dev, "deploy", {
    sourceDigest: sourceInventory().digest,
    runtime: "sha256:" + "a".repeat(64),
    app: "",
  });
  const text = JSON.stringify(p.templates);
  for (const type of [
    "AWS::EC2::VPC",
    "AWS::EC2::NatGateway",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::EC2::Instance",
    "AWS::Route53::RecordSet",
  ])
    expect(text).not.toContain(type);
  expect(text).toContain("AWS::BedrockAgentCore::Runtime");
  expect(
    Object.keys(p.templates).some((name) => name.endsWith("-Foundation")),
  ).toBe(false);
});
it("build bundle is deterministic, hash-checkable and excludes state, profiles, secrets and dependency trees", () => {
  const inventory = sourceInventory();
  expect(
    Object.keys(inventory.files).some((f) =>
      /node_modules|\.env$|\.state|\.deployment|vendor\//.test(f),
    ),
  ).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), "docintel-package-test-"));
  try {
    packageSource(join(dir, "one.zip"));
    packageSource(join(dir, "two.zip"));
    expect(digest(readFileSync(join(dir, "one.zip")))).toBe(
      digest(readFileSync(join(dir, "two.zip"))),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("retained-disk bootstrap refuses missing/wrong state and doesn't log OAuth/private request data", () => {
  const code = hostUserData(
    c,
    "vol-00000000000000000",
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/docintel-test-app@sha256:" +
      "a".repeat(64),
    {},
  );
  expect(code).toContain("Expected state volume missing");
  expect(code).toContain("State ownership marker mismatch");
  expect(code).toContain("Unexpected disk signature");
  expect(code).toContain("RequiresMountsFor");
  expect(code).toContain("access_log off");
  expect(code).not.toContain("set -x");
  expect(code).not.toContain("AWS_SECRET_ACCESS_KEY");
});
it("rejects unsafe subject/config controls and cross-account certificates", () => {
  expect(() =>
    Configuration.parse({
      ...c,
      principals: [{ subject: "bad\nsubject", documents: ["acme-2024"] }],
    }),
  ).toThrow();
  expect(() =>
    Configuration.parse({
      ...c,
      certificateArn: c.certificateArn!.replace("123456789012", "999999999999"),
    }),
  ).toThrow();
});
