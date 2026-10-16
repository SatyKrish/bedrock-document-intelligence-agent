// Approved reference deployment policy; stock managed lifecycle remains unchanged.
import { App, CfnResource, RemovalPolicies, Stack } from 'aws-cdk-lib';
import { CfnPolicy, CfnRole } from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';

export function applyReferenceDeploymentPolicy(app: App) {
  const all = app.node.findAll();
  const assets = all.filter((n): n is Asset => n instanceof Asset && /\/Application\/Agent(Alice|Bob)\/ContainerSourceAsset\/SourceAsset$/.test(n.node.path));
  if (assets.length !== 2) throw new Error('Review required: expected two owned source assets');
  const ownedObjects = assets.map(a => a.bucket.arnForObjects(a.s3ObjectKey));
  const ownedBuckets = [...new Set(assets.map(a => a.bucket.bucketArn))];
  const counts = { builds: 0, handlers: 0, buildPolicies: 0, handlerRoles: 0 };
  RemovalPolicies.of(app).retain();
  for (const node of all) {
    if (!(node instanceof CfnResource)) continue;
    const type = node.cfnResourceType;
    const path = node.node.path;
    if (type === 'AWS::ECR::Repository') {
      node.addPropertyDeletionOverride('LifecyclePolicy');
      node.addPropertyOverride('EmptyOnDelete', false);
    }
    if (type === 'AWS::Logs::LogGroup') node.addPropertyDeletionOverride('RetentionInDays');
    if (type === 'AWS::CodeBuild::Project' && /\/ContainerBuildProject-[0-9a-f]{8}\/ContainerBuildProject\/Resource$/.test(path)) {
      node.addPropertyDeletionOverride('VpcConfig');
      counts.builds++;
    }
    if (type === 'AWS::Lambda::Function' && /\/Application\/Agent(Alice|Bob)\/ContainerImageBuilder\/ContainerBuildHandler\/Resource$/.test(path)) {
      node.addPropertyDeletionOverride('VpcConfig');
      counts.handlers++;
    }
    if (node instanceof CfnRole && /\/Application\/Agent(Alice|Bob)\/ContainerImageBuilder\/ContainerBuildHandler\/ServiceRole\/Resource$/.test(path)) {
      const policies: unknown[] = Stack.of(node).resolve(node.managedPolicyArns);
      const kept = policies.filter(p => !JSON.stringify(p).includes('AWSLambdaVPCAccessExecutionRole'));
      if (policies.length - kept.length !== 1) throw new Error('Review required: handler VPC policy shape changed');
      node.addPropertyOverride('ManagedPolicyArns', kept);
      counts.handlerRoles++;
    }
    if (node instanceof CfnPolicy && /\/ContainerBuildProject-[0-9a-f]{8}\/ContainerBuildExecutionRole\/DefaultPolicy\/Resource$/.test(path)) {
      const doc = Stack.of(node).resolve(node.policyDocument);
      if (!Array.isArray(doc.Statement)) throw new Error('Review required: build policy shape changed');
      let sources = 0;
      doc.Statement = doc.Statement.flatMap((statement: Record<string, unknown>) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (!actions.every((a: unknown) => typeof a === 'string')) throw new Error('Review required: non-string actions');
        if (actions.some((a: string) => a.startsWith('s3:'))) {
          sources++;
          return [
            { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: ownedObjects },
            { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:GetBucketAcl'], Resource: ownedBuckets },
          ];
        }
        const remaining = actions.filter((a: string) => !a.startsWith('ec2:'));
        return remaining.length ? [{ ...statement, Action: remaining.length === 1 ? remaining[0] : remaining }] : [];
      });
      if (sources !== 1) throw new Error('Review required: expected one source asset grant');
      node.addPropertyOverride('PolicyDocument', doc);
      counts.buildPolicies++;
    }
  }
  if (Object.values(counts).some(n => n !== 2)) throw new Error(`Review required: deployment layout changed ${JSON.stringify(counts)}`);
}
