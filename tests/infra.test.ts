import { it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { DocumentSiloStack } from "../infra/stack.js";
it("synthesizes private native S3 Files and a managed exec-server runtime per principal", () => {
  const app = new App();
  const stack = new DocumentSiloStack(app, "TestSilo");
  const t = Template.fromStack(stack);
  t.resourceCountIs("AWS::S3::Bucket", 2);
  t.resourceCountIs("AWS::S3Files::FileSystem", 2);
  t.resourceCountIs("AWS::S3Files::AccessPoint", 2);
  t.resourceCountIs("AWS::S3Files::MountTarget", 4);
  t.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
    ProtocolConfiguration: "HTTP",
    LifecycleConfiguration: {
      IdleRuntimeSessionTimeout: 28800,
      MaxLifetime: 28800,
    },
  });
  const data = t.toJSON();
  const buckets = Object.values(data.Resources).filter(
    (r: any) => r.Type === "AWS::S3::Bucket",
  ) as any[];
  expect(
    buckets.every(
      (b) =>
        b.DeletionPolicy === "Retain" &&
        b.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,
    ),
  ).toBe(true);
  const runtime = Object.values(data.Resources).find(
    (r: any) => r.Type === "AWS::BedrockAgentCore::Runtime",
  ) as any;
  expect(runtime.Properties.FilesystemConfigurations).toHaveLength(3);
  expect(JSON.stringify(data)).not.toContain("bedrock:InvokeAgent");
});

it("seeds read-only skills and scopes writable root output mount and input staging", () => {
  const t = Template.fromStack(new DocumentSiloStack(new App(), "WiringSilo"));
  t.hasResourceProperties("AWS::S3Files::AccessPoint", {
    PosixUser: { Uid: "0", Gid: "0" },
    RootDirectory: { Path: "/" },
  });
  t.hasResourceProperties("Custom::CDKBucketDeployment", {
    DestinationBucketKeyPrefix: "skills",
    Prune: true,
    RetainOnDelete: true,
  });
  const data = t.toJSON();
  const runtime = Object.values(data.Resources).find(
    (r: any) => r.Type === "AWS::BedrockAgentCore::Runtime",
  ) as any;
  const seed = Object.keys(data.Resources).find(
    (id) => data.Resources[id].Type === "Custom::CDKBucketDeployment",
  );
  expect(runtime.DependsOn).toContain(seed);
  expect(runtime.Properties.EnvironmentVariables.BMA_RUST_LOG).toBe("warn");
  const policies = Object.entries(data.Resources).filter(
    ([, r]: any) => r.Type === "AWS::IAM::Policy",
  );
  const app = policies.find(([id]) =>
    id.startsWith("ApplicationSiloRole"),
  )![1] as any;
  const writes = app.Properties.PolicyDocument.Statement.filter((s: any) =>
    [s.Action].flat().includes("s3:PutObject"),
  );
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes[0].Resource)).toContain("/inputs/*");
  expect(JSON.stringify(writes)).not.toContain("skills");
  const rt = policies.find(([id]) => id.startsWith("RuntimeRole"))![1] as any;
  const root = rt.Properties.PolicyDocument.Statement.filter((s: any) =>
    [s.Action].flat().includes("s3files:ClientRootAccess"),
  );
  expect(root).toHaveLength(1);
  expect(JSON.stringify(root[0])).toContain("AccessPoint1");
  expect(JSON.stringify(root[0])).not.toContain("AccessPoint0");
  expect(data.Parameters.RuntimeImageDigest.AllowedPattern).toBe(
    "sha256:[a-f0-9]{64}",
  );
  expect(JSON.stringify(runtime.Properties.AgentRuntimeArtifact)).toContain(
    "RuntimeImageDigest",
  );
  expect(JSON.stringify(runtime.Properties.AgentRuntimeArtifact)).toContain(
    "AWS::AccountId",
  );
});
it("can reuse explicit private network metadata without creating a VPC, NAT or changing routes", () => {
  const stack = new DocumentSiloStack(new App(), "ReuseSilo", {
    existingNetwork: {
      region: "us-east-1",
      vpcId: "vpc-00000000000000000",
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
    },
  });
  const t = Template.fromStack(stack);
  for (const type of [
    "AWS::EC2::VPC",
    "AWS::EC2::NatGateway",
    "AWS::EC2::Route",
    "AWS::EC2::VPCEndpoint",
  ])
    t.resourceCountIs(type, 0);
  t.resourceCountIs("AWS::S3Files::MountTarget", 4);
});
