// PROPOSED ONLY: not imported by the canonical CLI project until separately approved.
// Explicit project CDK image-identity binding; no CLI schema field or lifecycle fork.
import { App, CfnResource, Stack } from 'aws-cdk-lib';
export function pinQualifiedBaselineImage(app: App, binding: { account: string; repository: string; digest: string }) {
  if (!/^\d{12}$/.test(binding.account) || !/^[a-z0-9][a-z0-9/_-]+$/.test(binding.repository) || !/^sha256:[a-f0-9]{64}$/.test(binding.digest)) throw new Error('Exact qualified ECR digest binding required');
  const targets = app.node.findAll().filter((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === 'AWS::BedrockAgentCore::Runtime' && /\/Application\/AgentBob\/Runtime\/Resource$/.test(node.node.path));
  if (targets.length !== 1) throw new Error('Expected exactly one existing Bob Runtime');
  const runtime = targets[0];
  if (Stack.of(runtime).account !== binding.account || Stack.of(runtime).region !== 'us-east-1') throw new Error('Approved account/region binding differs');
  runtime.addPropertyOverride('AgentRuntimeArtifact.ContainerConfiguration.ContainerUri', `${binding.account}.dkr.ecr.us-east-1.amazonaws.com/${binding.repository}@${binding.digest}`);
}
