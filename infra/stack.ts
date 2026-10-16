import {
  Stack,
  CfnParameter,
  CfnOutput,
  RemovalPolicy,
  Aws,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import * as deployment from "aws-cdk-lib/aws-s3-deployment";
import type { ExistingNetwork } from "./network.js";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3files from "aws-cdk-lib/aws-s3files";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
// Deploy one stack per authenticated principal. Shared mounts are not a tenant
// boundary. No lookup/context provider or Docker build is used during synth.
export class DocumentSiloStack extends Stack {
  readonly configOutputs: Record<string, string>;
  constructor(
    scope: Construct,
    id: string,
    props?: StackProps & {
      existingNetwork?: ExistingNetwork;
      providedVpc?: ec2.IVpc;
      deploymentPrefix?: string;
      seedSkills?: boolean;
    },
  ) {
    super(scope, id, props);
    const silo = new CfnParameter(this, "SiloId", {
      type: "String",
      default: "alice",
      allowedPattern: "[a-z][a-z0-9_]{0,30}",
    });
    const imageRepository = new CfnParameter(this, "RuntimeImageRepository", {
      type: "String",
      default: "docintel-runtime",
      allowedPattern: "docintel-[a-z0-9][a-z0-9._/-]{0,127}",
      description:
        "Reviewed private ECR repository in this stack's account and region",
    });
    const imageDigest = new CfnParameter(this, "RuntimeImageDigest", {
      type: "String",
      allowedPattern: "sha256:[a-f0-9]{64}",
      description:
        "Immutable digest of the reviewed Linux ARM64 image; no tags",
    });
    const imageUri = `${Aws.ACCOUNT_ID}.dkr.ecr.${Aws.REGION}.${Aws.URL_SUFFIX}/${imageRepository.valueAsString}@${imageDigest.valueAsString}`;
    const appPrincipal = new CfnParameter(this, "ApplicationPrincipalArn", {
      type: "String",
      description:
        "Existing reviewed application execution-role ARN; no identity provider is created",
    });
    const model = new CfnParameter(this, "BmaModel", {
      type: "String",
      default: "openai.gpt-5.6-luna",
    });
    const buckets = ["Inputs", "Outputs"].map(
      (name) =>
        new s3.Bucket(this, name, {
          versioned: true,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
    );
    const vpc: ec2.IVpc =
      props?.providedVpc ??
      (props?.existingNetwork
        ? ec2.Vpc.fromVpcAttributes(this, "ExistingVpc", {
            vpcId: props.existingNetwork.vpcId,
            availabilityZones: props.existingNetwork.privateSubnets.map(
              (s) => s.availabilityZone,
            ),
            privateSubnetIds: props.existingNetwork.privateSubnets.map(
              (s) => s.subnetId,
            ),
            privateSubnetRouteTableIds:
              props.existingNetwork.privateSubnets.map((s) => s.routeTableId),
          })
        : new ec2.Vpc(this, "Vpc", {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
              {
                name: "Private",
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              },
              { name: "Public", subnetType: ec2.SubnetType.PUBLIC },
            ],
          }));
    if (!props?.existingNetwork && !props?.providedVpc)
      vpc.addGatewayEndpoint("S3Endpoint", {
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });
    const runtimeSG = new ec2.SecurityGroup(this, "RuntimeSG", {
      vpc,
      allowAllOutbound: false,
    });
    const mountSG = new ec2.SecurityGroup(this, "MountSG", {
      vpc,
      allowAllOutbound: false,
    });
    runtimeSG.addEgressRule(mountSG, ec2.Port.tcp(2049));
    mountSG.addIngressRule(runtimeSG, ec2.Port.tcp(2049));
    runtimeSG.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "BMA/AgentCore HTTPS via NAT; review egress controls before production",
    );
    const bucketRole = new iam.Role(this, "S3FilesRole", {
      roleName: props?.deploymentPrefix
        ? props.deploymentPrefix + "-s3files"
        : undefined,
      assumedBy: new iam.ServicePrincipal("elasticfilesystem.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: {
            "aws:SourceArn": `arn:${Aws.PARTITION}:s3files:${Aws.REGION}:${Aws.ACCOUNT_ID}:file-system/*`,
          },
        },
      }),
    });
    for (const b of buckets) b.grantReadWrite(bucketRole);
    bucketRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucketVersions"],
        resources: buckets.map((b) => b.bucketArn),
      }),
    );
    bucketRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObjectVersion",
          "s3:DeleteObjectVersion",
          "s3:ListMultipartUploadParts",
        ],
        resources: buckets.map((b) => b.arnForObjects("*")),
      }),
    );
    bucketRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "events:DeleteRule",
          "events:DisableRule",
          "events:EnableRule",
          "events:PutRule",
          "events:PutTargets",
          "events:RemoveTargets",
        ],
        resources: [
          `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/DO-NOT-DELETE-S3-Files*`,
        ],
        conditions: {
          StringEquals: {
            "events:ManagedBy": "elasticfilesystem.amazonaws.com",
          },
        },
      }),
    );
    bucketRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "events:DescribeRule",
          "events:ListRuleNamesByTarget",
          "events:ListRules",
          "events:ListTargetsByRule",
        ],
        resources: [
          `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/*`,
        ],
      }),
    );
    // Retained filesystems need their backing role and policy after stack removal.
    bucketRole.applyRemovalPolicy(RemovalPolicy.RETAIN);
    (
      bucketRole.node.findChild("DefaultPolicy").node
        .defaultChild as import("aws-cdk-lib").CfnResource
    ).applyRemovalPolicy(RemovalPolicy.RETAIN);
    const mounts: s3files.CfnMountTarget[] = [];
    const files = buckets.map((b, i) => {
      const c = b.node.defaultChild as s3.CfnBucket;
      c.notificationConfiguration = {
        eventBridgeConfiguration: { eventBridgeEnabled: true },
      };
      const fs = new s3files.CfnFileSystem(this, `FileSystem${i}`, {
        bucket: b.bucketArn,
        roleArn: bucketRole.roleArn,
      });
      fs.node.addDependency(bucketRole.node.findChild("DefaultPolicy"));
      fs.applyRemovalPolicy(RemovalPolicy.RETAIN);
      vpc.privateSubnets.forEach((subnet, j) =>
        mounts.push(
          new s3files.CfnMountTarget(this, `Mount${i}${j}`, {
            fileSystemId: fs.attrFileSystemId,
            subnetId: subnet.subnetId,
            securityGroups: [mountSG.securityGroupId],
          }),
        ),
      );
      const ap = new s3files.CfnAccessPoint(this, `AccessPoint${i}`, {
        fileSystemId: fs.attrFileSystemId,
        // Follow the official sample: root access is limited to this output AP.
        posixUser: { uid: i === 1 ? "0" : "1000", gid: i === 1 ? "0" : "1000" },
        rootDirectory: { path: "/" },
      });
      ap.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return { fs, ap };
    });
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      roleName: props?.deploymentPrefix
        ? props.deploymentPrefix + "-runtime"
        : undefined,
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: {
            "aws:SourceArn": `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:runtime/*`,
          },
        },
      }),
    });
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        resources: [
          `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${imageRepository.valueAsString}`,
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/*`,
        ],
      }),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-mantle:RegisterEnvironment",
          "bedrock-mantle:ConnectEnvironment",
        ],
        resources: [
          `arn:${Aws.PARTITION}:bedrock-mantle:${Aws.REGION}:${Aws.ACCOUNT_ID}:project/*`,
        ],
      }),
    );
    for (const [i, { fs, ap }] of files.entries()) {
      runtimeRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3files:GetAccessPoint"],
          resources: [ap.attrAccessPointArn],
        }),
      );
      runtimeRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "s3files:GetFileSystem",
            "s3files:GetMountTarget",
            "s3files:ListMountTargets",
          ],
          resources: [fs.attrFileSystemArn],
        }),
      );
      runtimeRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "s3files:ClientMount",
            ...(i === 1
              ? ["s3files:ClientWrite", "s3files:ClientRootAccess"]
              : []),
          ],
          resources: [fs.attrFileSystemArn],
          conditions: {
            ArnEquals: { "s3files:AccessPointArn": ap.attrAccessPointArn },
          },
        }),
      );
    }
    const runtime = new agentcore.CfnRuntime(this, "Runtime", {
      agentRuntimeName: `docintel_${silo.valueAsString}`,
      roleArn: runtimeRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: imageUri },
      },
      networkConfiguration: {
        networkMode: "VPC",
        networkModeConfig: {
          subnets: vpc.privateSubnets.map((s) => s.subnetId),
          securityGroups: [runtimeSG.securityGroupId],
        },
      },
      protocolConfiguration: "HTTP",
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 28800,
        maxLifetime: 28800,
      },
      filesystemConfigurations: [
        { sessionStorage: { mountPath: "/mnt/workspace" } },
        {
          s3FilesAccessPoint: {
            accessPointArn: files[0].ap.attrAccessPointArn,
            mountPath: "/mnt/bma",
          },
        },
        {
          s3FilesAccessPoint: {
            accessPointArn: files[1].ap.attrAccessPointArn,
            mountPath: "/mnt/output",
          },
        },
      ],
      environmentVariables: {
        BMA_REGION: Aws.REGION,
        BMA_ENDPOINT: `https://bedrock-mantle.${Aws.REGION}.api.aws`,
        BMA_SERVICE: "bedrock-mantle",
        BMA_REMOTE_TRANSPORT: "direct",
        BMA_RUST_LOG: "warn",
        BMA_WORKSPACE_DIR: "/mnt/workspace",
        BMA_MOUNT_PATH: "/mnt/bma",
        BMA_OUTPUTS_MOUNT_PATH: "/mnt/output",
        BMA_SKILLS_PREFIX: "skills",
      },
    });
    if (props?.seedSkills !== false) {
      const skills = new deployment.BucketDeployment(this, "SeedSkills", {
        destinationBucket: buckets[0],
        destinationKeyPrefix: "skills",
        sources: [
          deployment.Source.asset(
            fileURLToPath(new URL("../agent/skills", import.meta.url)),
          ),
        ],
        prune: true,
        retainOnDelete: true,
      });
      runtime.node.addDependency(skills);
    }
    for (const m of mounts) runtime.node.addDependency(m);
    for (const { ap } of files) runtime.node.addDependency(ap);
    runtime.node.addDependency(runtimeRole.node.findChild("DefaultPolicy"));
    const sessionRole = new iam.Role(this, "SessionRole", {
      roleName: props?.deploymentPrefix
        ? props.deploymentPrefix + "-session"
        : undefined,
      assumedBy: new iam.ServicePrincipal("bedrock-mantle.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: {
            "aws:SourceArn": `arn:${Aws.PARTITION}:bedrock-mantle:*:${Aws.ACCOUNT_ID}:*`,
          },
        },
      }),
    });
    sessionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-mantle:CreateInference"],
        resources: ["*"],
        conditions: {
          StringEquals: { "bedrock-mantle:Model": model.valueAsString },
        },
      }),
    );
    sessionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:StopRuntimeSession",
        ],
        resources: [
          runtime.attrAgentRuntimeArn,
          `${runtime.attrAgentRuntimeArn}/runtime-endpoint/*`,
        ],
      }),
    );
    const clientRole = new iam.Role(this, "ApplicationSiloRole", {
      roleName: props?.deploymentPrefix
        ? props.deploymentPrefix + "-app"
        : undefined,
      assumedBy: new iam.ArnPrincipal(appPrincipal.valueAsString),
    });
    clientRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-mantle:CreateAgentSession",
          "bedrock-mantle:GetAgentSession",
          "bedrock-mantle:DeleteAgentSession",
          "bedrock-mantle:CreateAgentSessionEvent",
          "bedrock-mantle:ListAgentSessionEvents",
          "bedrock-mantle:ListAgentSessionItems",
        ],
        resources: [
          `arn:${Aws.PARTITION}:bedrock-mantle:${Aws.REGION}:${Aws.ACCOUNT_ID}:project/*`,
        ],
      }),
    );
    clientRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [sessionRole.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "bedrock-mantle.amazonaws.com",
          },
        },
      }),
    );
    clientRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [buckets[0].arnForObjects("inputs/*")],
      }),
    );
    buckets[1].grantRead(clientRole);
    this.configOutputs = {
      runtimeArn: runtime.attrAgentRuntimeArn,
      roleArn: sessionRole.roleArn,
      applicationRoleArn: clientRole.roleArn,
      inputBucket: buckets[0].bucketName,
      outputBucket: buckets[1].bucketName,
    };
    new CfnOutput(this, "BackingRoleArn", { value: bucketRole.roleArn });
    new CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, "SessionRoleArn", { value: sessionRole.roleArn });
    new CfnOutput(this, "ApplicationSiloRoleArn", {
      value: clientRole.roleArn,
    });
    new CfnOutput(this, "InputsBucket", { value: buckets[0].bucketName });
    new CfnOutput(this, "OutputsBucket", { value: buckets[1].bucketName });
  }
}
