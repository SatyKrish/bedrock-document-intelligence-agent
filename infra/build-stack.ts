import {
  Stack,
  RemovalPolicy,
  CfnOutput,
  Duration,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Config } from "../deployment/config.js";
import { buildSpec } from "../deployment/buildspec.js";
export class ImageBuildStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    c: Config,
    sourceDigest: string,
    props?: StackProps,
  ) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, "Source", {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const runtime = new ecr.Repository(this, "RuntimeImage", {
      repositoryName: `docintel-${c.deploymentId}-runtime`,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const app =
      c.mode === "hosted"
        ? new ecr.Repository(this, "AppImage", {
            repositoryName: `docintel-${c.deploymentId}-app`,
            imageTagMutability: ecr.TagMutability.IMMUTABLE,
            imageScanOnPush: true,
            removalPolicy: RemovalPolicy.RETAIN,
          })
        : undefined;
    const role = new iam.Role(this, "BuilderRole", {
      roleName: `docintel-${c.deploymentId}-builder`,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": c.account },
          ArnEquals: {
            "aws:SourceArn": `arn:aws:codebuild:${c.region}:${c.account}:project/docintel-${c.deploymentId}`,
          },
        },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [bucket.arnForObjects(`source/${sourceDigest}.zip`)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects(`results/${sourceDigest}.json`)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:DescribeImages",
        ],
        resources: [runtime.repositoryArn, ...(app ? [app.repositoryArn] : [])],
      }),
    );
    const log = new logs.LogGroup(this, "BuildLog", {
      logGroupName: `/docintel/${c.deploymentId}/build`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [log.logGroupArn + ":*"],
      }),
    );
    const project = new codebuild.CfnProject(this, "Project", {
      name: `docintel-${c.deploymentId}`,
      serviceRole: role.roleArn,
      concurrentBuildLimit: 1,
      timeoutInMinutes: 30,
      queuedTimeoutInMinutes: 5,
      artifacts: { type: "NO_ARTIFACTS" },
      source: {
        type: "S3",
        location: bucket.bucketName + `/source/${sourceDigest}.zip`,
        buildSpec: JSON.stringify(buildSpec),
      },
      environment: {
        type: "ARM_CONTAINER",
        image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
        computeType: "BUILD_GENERAL1_SMALL",
        privilegedMode: false,
        environmentVariables: [
          { name: "SOURCE_DIGEST", value: sourceDigest },
          { name: "DEPLOY_MODE", value: c.mode },
          {
            name: "REGISTRY",
            value: `${c.account}.dkr.ecr.${c.region}.amazonaws.com`,
          },
          { name: "RUNTIME_REPO", value: runtime.repositoryName },
          { name: "APP_REPO", value: app?.repositoryName ?? "" },
          { name: "SOURCE_BUCKET", value: bucket.bucketName },
        ],
      },
      logsConfig: {
        cloudWatchLogs: { status: "ENABLED", groupName: log.logGroupName },
      },
    });
    project.node.addDependency(role.node.findChild("DefaultPolicy"));
    new CfnOutput(this, "SourceBucket", { value: bucket.bucketName });
    new CfnOutput(this, "ProjectName", { value: project.name! });
    new CfnOutput(this, "RuntimeRepository", { value: runtime.repositoryName });
    if (app)
      new CfnOutput(this, "AppRepository", { value: app.repositoryName });
  }
}
