import { Stack, CfnOutput, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Config } from "../deployment/config.js";
import { principalKey, roleName } from "../deployment/config.js";
export class FoundationStack extends Stack {
  readonly vpc: ec2.IVpc;
  readonly appRoleArn: string;
  constructor(scope: Construct, id: string, c: Config, props?: StackProps) {
    super(scope, id, props);
    this.vpc =
      c.network.kind === "new"
        ? new ec2.Vpc(this, "Vpc", {
            natGateways: 1,
            availabilityZones: c.availabilityZones,
            subnetConfiguration: [
              { name: "Public", subnetType: ec2.SubnetType.PUBLIC },
              {
                name: "Private",
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              },
            ],
          })
        : ec2.Vpc.fromVpcAttributes(this, "ImportedVpc", {
            vpcId: c.network.vpcId,
            vpcCidrBlock: c.network.vpcCidr,
            availabilityZones: c.network.privateSubnets.map(
              (s) => s.availabilityZone,
            ),
            privateSubnetIds: c.network.privateSubnets.map((s) => s.subnetId),
            privateSubnetRouteTableIds: c.network.privateSubnets.map(
              (s) => s.routeTableId,
            ),
            publicSubnetIds: c.network.publicSubnets.map((s) => s.subnetId),
            publicSubnetRouteTableIds: c.network.publicSubnets.map(
              (s) => s.routeTableId,
            ),
          });
    if (c.network.kind === "new")
      this.vpc.addGatewayEndpoint("S3Endpoint", {
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });
    if (c.mode === "hosted") {
      const role = new iam.Role(this, "ApplicationRole", {
        roleName: `docintel-${c.deploymentId}-application`,
        assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: c.principals.map(
            (p) =>
              `arn:aws:iam::${c.account}:role/${roleName(c, principalKey(p.subject), "app")}`,
          ),
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
          actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
          resources: [
            `arn:aws:ecr:${c.region}:${c.account}:repository/docintel-${c.deploymentId}-app`,
          ],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${c.region}:${c.account}:parameter/docintel/${c.deploymentId}/silos`,
          ],
        }),
      );
      this.appRoleArn = role.roleArn;
      new CfnOutput(this, "ApplicationRoleArn", { value: role.roleArn });
    } else this.appRoleArn = c.developerCallerArn!;
    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    this.vpc.privateSubnets.forEach((s, i) => {
      new CfnOutput(this, `PrivateSubnet${i}`, { value: s.subnetId });
      new CfnOutput(this, `PrivateRoute${i}`, {
        value: s.routeTable.routeTableId,
      });
      new CfnOutput(this, `PrivateAz${i}`, { value: s.availabilityZone });
    });
    this.vpc.publicSubnets.forEach((s, i) => {
      new CfnOutput(this, `PublicSubnet${i}`, { value: s.subnetId });
      new CfnOutput(this, `PublicRoute${i}`, {
        value: s.routeTable.routeTableId,
      });
      new CfnOutput(this, `PublicAz${i}`, { value: s.availabilityZone });
    });
  }
}
