import { Stack, CfnOutput, RemovalPolicy, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as rtargets from "aws-cdk-lib/aws-route53-targets";
import type { Config } from "../deployment/config.js";
import { hostUserData } from "../deployment/host-user-data.js";
export class ApplicationHostStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    c: Config,
    vpc: ec2.IVpc,
    appRoleArn: string,
    image: string,
    silos: Record<string, unknown>,
    props?: StackProps,
  ) {
    super(scope, id, props);
    const configParameter = new ssm.StringParameter(this, "SiloConfiguration", {
      parameterName: `/docintel/${c.deploymentId}/silos`,
      stringValue: JSON.stringify(silos),
    });
    const role = iam.Role.fromRoleArn(this, "AppRole", appRoleArn, {
      mutable: false,
    });
    const albSG = new ec2.SecurityGroup(this, "Ingress", {
      vpc,
      allowAllOutbound: false,
    });
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    const hostSG = new ec2.SecurityGroup(this, "AppSG", {
      vpc,
      allowAllOutbound: false,
    });
    albSG.addEgressRule(hostSG, ec2.Port.tcp(8080));
    hostSG.addIngressRule(albSG, ec2.Port.tcp(8080));
    hostSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    const subnet = vpc.privateSubnets[0];
    const volume = new ec2.CfnVolume(this, "StateVolume", {
      availabilityZone: subnet.availabilityZone,
      encrypted: true,
      size: 8,
      volumeType: "gp3",
      tags: [{ key: "DocIntelDeploymentId", value: c.deploymentId }],
    });
    volume.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const instance = new ec2.Instance(this, "Application", {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      role,
      securityGroup: hostSG,
      instanceType: new ec2.InstanceType("t4g.small"),
      machineImage: ec2.MachineImage.genericLinux({ [c.region]: c.amiId }),
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    const cfn = instance.node.defaultChild as ec2.CfnInstance;
    cfn.metadataOptions = {
      httpTokens: "required",
      httpPutResponseHopLimit: 2,
      httpEndpoint: "enabled",
    };
    instance.addUserData(hostUserData(c, volume.ref, image, silos));
    instance.node.addDependency(configParameter);
    new ec2.CfnVolumeAttachment(this, "StateAttachment", {
      device: "/dev/sdf",
      instanceId: instance.instanceId,
      volumeId: volume.ref,
    });
    const alb = new elb.ApplicationLoadBalancer(this, "Https", {
      vpc,
      internetFacing: true,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const listener = alb.addListener("TLS", {
      port: 443,
      open: false,
      certificates: [
        acm.Certificate.fromCertificateArn(
          this,
          "ApprovedCertificate",
          c.certificateArn!,
        ),
      ],
    });
    listener.addTargets("Service", {
      port: 8080,
      protocol: elb.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(instance, 8080)],
      healthCheck: { path: "/healthz", healthyHttpCodes: "200" },
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "ApprovedZone",
      { hostedZoneId: c.hostedZone!.id, zoneName: c.hostedZone!.name },
    );
    new route53.ARecord(this, "WebDns", {
      zone,
      recordName: new URL(c.publicOrigin).hostname,
      target: route53.RecordTarget.fromAlias(
        new rtargets.LoadBalancerTarget(alb),
      ),
    });
    new CfnOutput(this, "WebUrl", { value: c.publicOrigin });
    new CfnOutput(this, "McpUrl", { value: c.publicOrigin + "/mcp" });
    new CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
    new CfnOutput(this, "StateVolumeId", { value: volume.ref });
    new CfnOutput(this, "ApplicationInstanceId", {
      value: instance.instanceId,
    });
  }
}
