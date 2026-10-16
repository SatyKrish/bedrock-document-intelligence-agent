> For the next isolated test, use the [AWS baseline proposal](aws-baseline.md).
> Its exact new NAT/security changes require separate approval. The completed
> PrivateLink-only experiment is historical and unqualified. Generic reuse examples
> below do not authorize changes to any existing shared network.

# AWS prerequisites for the reference

Start here before [AgentCore deployment](agentcore-cli.md). These are documented
operator commands, not a provisioning script or evidence of a deployed system.
Only an approved operator may run write commands. Permission must cover the exact
account, region, resources, IAM changes, privileged builds, runtime/model usage,
cost reservation and retain-data failure handling. An approval of documentation
or selection of an identity design does not authorize these writes.

The canonical runtime build/deploy path is the official AgentCore CLI. It accepts
existing role/AP/network identifiers; version 0.31.1 does not create the scoped
S3 Files/IAM/network prerequisites described here. Supply approved existing ones,
or obtain explicit approval to prepare them with the official AWS CLI. Do not
substitute the retired custom CDK deployment controller.

## Tools and capability checks — local only

| Tool              | Reference requirement                                           | Verified here                                                                                                                                               |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node/npm          | Node 24 LTS; repository lockfile; official npm registry         | Local checks used Node 25.8.2; transitive engine warning remains                                                                                            |
| AgentCore CLI     | Local `@aws/agentcore` exactly 0.31.1                           | Generation, validation, native dry run and approved deployment passed                                                                                       |
| Generated CDK     | Record approved project customization; lock local dependencies  | `@aws/agentcore-cdk` 0.1.0-alpha.54 source inspected                                                                                                        |
| AWS CLI           | Current official v2 with `s3files` and runtime-session commands | Installed 2.34.20 rejects `s3files`; verified temporary official 2.38.1 parses its skeleton; four owned filesystems/APs/mount targets created and available |
| Container tooling | Official CLI uses AWS CodeBuild for ARM64 images                | Local Docker daemon unavailable; two native ARM64 images built and statically qualified for bounded testing                                                 |
| Python/uv         | Optional host tools for sample client/lock maintenance          | Not required for the TS app; generated image supplies Python                                                                                                |

The [current dated live-test record](validation-status.md) describes the actual
created resources, registry failure and scoped cleanup. Generic instructions below are not a claim
that the whole sequence ran.

The official [AWS CLI reference](https://docs.aws.amazon.com/cli/latest/reference/s3files/)
currently documents `s3files` under 2.37.9. This is a documentation version, not a
claimed minimum or locally tested release. Follow the official
[installation/update and verification instructions](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
for your OS; record the chosen version. Do not edit global config or install a
replacement CLI without the operator's approval. Confirm capabilities without API
requests (a skeleton is printed locally):

```sh
node --version
npm --version
aws --version
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run agentcore -- --version
aws s3files create-file-system --generate-cli-skeleton input
aws s3files create-mount-target --generate-cli-skeleton input
aws s3files create-access-point --generate-cli-skeleton input
aws s3files put-file-system-policy --generate-cli-skeleton input
aws bedrock-agentcore stop-runtime-session --generate-cli-skeleton input
```

Install generated CDK dependencies from the lockfile, with lifecycle scripts off,
inside `agentcore-reference/DocIntelReference/agentcore/cdk` using `npm ci
--ignore-scripts --registry=https://registry.npmjs.org`, then return to the repo
root. Do not change generated CDK TypeScript or lifecycle Python. Local `npm run
build` is an application build; it does not build an AWS image.

## Exact resource inventory

The executed bounded test uses one approved subnet/AZ and four mount targets;
see the [single-AZ design](validation-status.md). Production should use a
reviewed redundant design. The inventory below illustrates two owners and two
approved private subnets in different Availability Zones:

| Prerequisite                            |                               Count | Ownership and scope                                                                         |
| --------------------------------------- | ----------------------------------: | ------------------------------------------------------------------------------------------- |
| Existing VPC/private subnets/NAT egress |                    1 / 2 / existing | Read-only reuse; no new NAT, public IP, routes or endpoint                                  |
| Private versioned SSE-S3 buckets        |                                   4 | Separate input and output bucket per owner; TLS; all public access blocked                  |
| S3 Files filesystems/access points      |                               4 / 4 | One filesystem/AP per bucket; no shared owner prefix as a boundary                          |
| Mount targets                           |                                   8 | Each of four filesystems in both approved subnet AZs                                        |
| Runtime and mount security groups       |                                   4 | One pair per owner; no edits to shared/default groups                                       |
| Prerequisite IAM roles                  |                                   8 | Runtime, BMA session, application and S3 Files backing role per owner                       |
| Inline/resource policies                | Reviewed per role/bucket/filesystem | No administrator/full-access attachment; no credentials or public principals granted access |

The generated CLI stack separately creates two Runtimes, two privileged ARM small
CodeBuild projects, two ECR repositories, two KMS keys, two build-handler Lambdas,
four IAM roles/four policies, two Lambda build-handler log groups and two custom
resources, plus
CDK metadata. The two handler log groups have a stock 731-day retention period.
CodeBuild/runtime log groups and service-managed synchronization resources can
also appear when used. Existing bootstrap assets are separate. Inspect the actual
synthesized diff: this inventory is a baseline, not permission for unlisted
service-linked roles, new bootstrap resources or account-wide observability.

Use a unique deployment name and labels `alice`/`bob`; these labels are not login
credentials. Record every created physical ID, role ARN, policy digest, request ID,
client token, bucket name and source digest in a protected receipt directory. If a
name exists but ownership is unproven, stop rather than adopting or updating it.

## Operator inputs and read-only account/network checks

Examples below assume a POSIX shell, repository root, and this non-secret input
set. Replace values and verify the account before any write. Never put access
keys, session tokens or OAuth secrets into these files or shell transcripts.

```sh
export DOCINTEL_PROFILE='your-existing-approved-profile'
export DOCINTEL_REGION='us-east-1'
export AWS_PROFILE="$DOCINTEL_PROFILE"
export AWS_REGION="$DOCINTEL_REGION"
export AWS_DEFAULT_REGION="$DOCINTEL_REGION"
export DOCINTEL_ACCOUNT='123456789012'
export DOCINTEL_DEPLOYMENT='DocIntelExample'
export DOCINTEL_OWNER='alice'  # repeat the owner-specific steps for bob
export DOCINTEL_VPC_ID='vpc-REPLACE'
export DOCINTEL_SUBNET_A='subnet-REPLACE_A'
export DOCINTEL_SUBNET_B='subnet-REPLACE_B'
umask 077
mkdir -p .deployment/reference/alice .deployment/reference/bob
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" sts get-caller-identity
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 describe-subnets \
  --subnet-ids "$DOCINTEL_SUBNET_A" "$DOCINTEL_SUBNET_B"
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 describe-route-tables \
  --filters "Name=vpc-id,Values=$DOCINTEL_VPC_ID"
```

Check DNS resolution, enough subnet IPs, same VPC, distinct AZs and approved existing
HTTPS egress through NAT/endpoints. Runtime and VPC CodeBuild both need egress to
AWS and official build registries. Do not add a NAT, Internet route, VPC endpoint,
proxy or new ingress to fix a failure under a runtime-only budget. Obtain an
operator authentication handoff if credentials expire; do not create access keys
or alter SSO configuration. STS success does not prove the Node SDK's SSO cache is
valid; see [troubleshooting](aws-validation.md#troubleshooting).

Before the first native CLI dry run/deploy, verify its Node credential chain uses
the same approved identity. `DOCINTEL_PROFILE` is only an example variable; the
CLI consumes `AWS_PROFILE` or inherited AWS credentials, not the target JSON.
Inherited access-key, role/web-identity or container-credential environment values
can select another identity. Do not print their values, unset shared settings or
assume `AWS_PROFILE` overrides them. Use an approved per-command child environment
with the intended source, or stop for an operator authentication handoff. The
following read-only verification mirrors the CLI credential-source branch, uses
the installed credential-provider package and an official AWS CLI STS child, and returns
only caller metadata; compare both account and full ARN with the named-profile
STS result before proceeding:

```sh
node --input-type=module <<'JS'
import { fromEnv, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { spawnSync } from "node:child_process";
// Match AgentCore CLI 0.31.1 credential-source selection exactly.
const provider = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  ? fromEnv() : fromNodeProviderChain();
const credentials = await provider();
// Pass resolved credentials only in memory to an STS-only AWS CLI child.
const childEnv = { ...process.env,
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
};
for (const name of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SECURITY_TOKEN",
  "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"])
  delete childEnv[name];
if (credentials.sessionToken) childEnv.AWS_SESSION_TOKEN = credentials.sessionToken;
else delete childEnv.AWS_SESSION_TOKEN;
const result = spawnSync("aws", ["--region", process.env.DOCINTEL_REGION,
  "sts", "get-caller-identity", "--output", "json", "--no-cli-pager"], {
  env: childEnv, encoding: "utf8", timeout: 20000, maxBuffer: 1048576,
});
if (result.error || result.status !== 0)
  throw new Error("Node identity check failed; obtain an operator auth handoff");
const identity = JSON.parse(result.stdout);
if (identity.Account !== process.env.DOCINTEL_ACCOUNT)
  throw new Error("Node credential account does not match the approved account");
console.log(JSON.stringify({ Account: identity.Account, Arn: identity.Arn }));
JS
```

This check can still fail because the Node SSO cache differs from the AWS CLI
cache; a successful named-profile STS call alone is not sufficient. Credentials
must remain in their existing approved provider chain or protected process memory.
Do not persist an export in a receipt, dot-env file or terminal transcript.

## 1. Render and review owner-specific policies locally

Copy the [policy examples](examples/aws/README.md) into each owner's protected
receipt directory. Edit the copies; keep the public examples generic. Replace
`__TOKEN__` values with the exact approved account, operator role, bucket names,
filesystem/AP IDs, expected CLI repository and runtime/log name prefix. JSON does
not expand environment variables. Do not pass unresolved templates to AWS.

Create only roles whose trust is currently renderable. The runtime role can start
with a reviewed source-ARN pattern for its expected Runtime name in the one
account/region; tighten it to the exact ARN after creation. The backing role can
start with the same-account/region filesystem pattern; tighten to its owner's two
filesystem ARNs after creation. Both temporary patterns must be disclosed in the
approval. Session permissions are attached only after the owned Runtime ARN is
known. Do not replace unknown ARNs with unrestricted `*` to make creation pass.

Role creation and policy attachment are separate writes. For each approved role,
use the exact rendered trust/policy pair from the mapping below. Commands show
one role; repeat deliberately, preserving each receipt, not as an unattended loop.

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" iam create-role \
  --role-name 'REPLACE_OWNER_ROLE_NAME' \
  --assume-role-policy-document file://.deployment/reference/alice/REPLACE-trust.json \
  --max-session-duration 3600 \
  --tags Key=DocIntelDeployment,Value=REPLACE_DEPLOYMENT
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" iam put-role-policy \
  --role-name 'REPLACE_OWNER_ROLE_NAME' --policy-name DocIntelOwnedScope \
  --policy-document file://.deployment/reference/alice/REPLACE-policy.json
```

Do not apply `runtime-policy` before filling filesystem/AP values. The S3 Files
backing role and its bucket policy must be ready before filesystem creation; the
runtime role must exist before its filesystem resource policy is installed. The
application role trusts only an approved existing operator/backend role. Its
caller also needs permission to assume that exact role; do not change shared
operator-role policy without explicit approval. Native CLI import is immutable:
it does not add missing permissions to imported runtime roles.

## 2. Create private buckets and synchronization prerequisites — approved writes

Choose four globally unique names, two per owner. The examples target us-east-1,
where `create-bucket` must omit a LocationConstraint. If you change region, review
all service/model support and use that region's documented bucket syntax.

For each new owned bucket, render its exact TLS-only bucket policy and run:

```sh
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api create-bucket \
  --bucket 'REPLACE_BUCKET' --object-ownership BucketOwnerEnforced
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api put-public-access-block \
  --bucket 'REPLACE_BUCKET' \
  --public-access-block-configuration file://docs/examples/aws/bucket-public-access.example.json
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api put-bucket-encryption \
  --bucket 'REPLACE_BUCKET' \
  --server-side-encryption-configuration file://docs/examples/aws/bucket-encryption.example.json
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api put-bucket-versioning \
  --bucket 'REPLACE_BUCKET' --versioning-configuration Status=Enabled
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api put-bucket-policy \
  --bucket 'REPLACE_BUCKET' --policy file://.deployment/reference/alice/bucket-policy.json
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api put-bucket-notification-configuration \
  --bucket 'REPLACE_BUCKET' \
  --notification-configuration file://docs/examples/aws/bucket-notifications.example.json
aws --profile "$DOCINTEL_PROFILE" --region us-east-1 s3api put-bucket-tagging \
  --bucket 'REPLACE_BUCKET' \
  --tagging 'TagSet=[{Key=DocIntelDeployment,Value=REPLACE_DEPLOYMENT},{Key=Owner,Value=REPLACE_OWNER}]'
```

The notification command replaces the whole configuration, which is why these
steps apply only to new dedicated buckets. Do not apply it to an existing shared
bucket. Bucket ownership controls, public access blocking, encryption, versioning,
policy and notifications must all be read back before use. Use SSE-S3 here; adding
customer-managed bucket keys would change permissions, cost and approval scope.

## 3. Create one security-group pair per owner — approved writes

Create new groups in the approved VPC, tag them, and record their returned GroupIds:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 create-security-group \
  --vpc-id "$DOCINTEL_VPC_ID" --group-name 'REPLACE_OWNER-runtime' \
  --description 'Document intelligence isolated runtime and build egress' \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=DocIntelDeployment,Value=REPLACE_DEPLOYMENT}]'
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 create-security-group \
  --vpc-id "$DOCINTEL_VPC_ID" --group-name 'REPLACE_OWNER-mount' \
  --description 'Document intelligence owned S3 Files mount targets' \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=DocIntelDeployment,Value=REPLACE_DEPLOYMENT}]'
```

New groups have default egress rules. Inspect rules and revoke only the actual
egress rule IDs belonging to each newly created group. Do not assume an IPv6 rule
exists, and never revoke a shared group's rule. Then add the three intended flows:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 describe-security-group-rules \
  --filters 'Name=group-id,Values=REPLACE_NEW_SG' --query 'SecurityGroupRules[?IsEgress==`true`]'
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 revoke-security-group-egress \
  --group-id 'REPLACE_NEW_SG' --security-group-rule-ids 'sgr-REPLACE_REVIEWED_DEFAULT_RULE'
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 authorize-security-group-egress \
  --group-id 'REPLACE_RUNTIME_SG' \
  --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=Approved-test-HTTPS-egress}]'
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 authorize-security-group-egress \
  --group-id 'REPLACE_RUNTIME_SG' \
  --ip-permissions 'IpProtocol=tcp,FromPort=2049,ToPort=2049,UserIdGroupPairs=[{GroupId=REPLACE_MOUNT_SG}]'
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ec2 authorize-security-group-ingress \
  --group-id 'REPLACE_MOUNT_SG' \
  --ip-permissions 'IpProtocol=tcp,FromPort=2049,ToPort=2049,UserIdGroupPairs=[{GroupId=REPLACE_RUNTIME_SG}]'
```

Runtime groups have no inbound rules. Mount groups have no outbound initiation
rules and permit NFS only from their owner's runtime group; responses are
stateful. Neither owner gets access to the other's mount group. HTTPS to
0.0.0.0/0 is a disclosed test allowance, not a production egress allowlist. No SSH,
public ingress, all-protocol rule or global/default-group edit is part of setup.
The CLI uses the runtime VPC configuration for its CodeBuild project too.

## 4. Create S3 Files resources — approved writes

For each of four buckets, use its owner's backing role and a stable, recorded
client token (maximum 64 characters). Persist token and response before continuing.
If the response is lost, reconcile with read-only list/get and the same token;
do not invent another token or create duplicate resources.

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files create-file-system \
  --bucket 'arn:aws:s3:::REPLACE_BUCKET' \
  --role-arn 'arn:aws:iam::123456789012:role/REPLACE_OWNER_BACKING_ROLE' \
  --client-token 'REPLACE_STABLE_FS_TOKEN' \
  --tags key=DocIntelDeployment,value=REPLACE_DEPLOYMENT key=Owner,value=REPLACE_OWNER
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files get-file-system \
  --file-system-id 'fs-REPLACE'
```

Wait for `status: available`; stop on `error`. Read warnings and fix the exact new
bucket configuration; do not add `--accept-bucket-warning` without review. Omitting
`--kms-key-id` uses service-owned filesystem encryption; no extra customer key is
created here. For every filesystem, create a target in each approved AZ using the
owner's mount security group explicitly, then read back readiness:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files create-mount-target \
  --file-system-id 'fs-REPLACE' --subnet-id "$DOCINTEL_SUBNET_A" \
  --security-groups 'sg-REPLACE_OWNER_MOUNT' --ip-address-type IPV4_ONLY
# Repeat for DOCINTEL_SUBNET_B, preserving each returned mountTargetId.
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files list-mount-targets \
  --file-system-id 'fs-REPLACE'
```

Wait for both targets to become available; no undocumented waiter is assumed.
A lost target-creation response requires listing that filesystem/AZ before retry,
because this operation has no client-token option in the reviewed CLI reference.
Create one access point per filesystem. Use the first command for input and the
second for output; both root paths map directly to their dedicated bucket:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files create-access-point \
  --file-system-id 'fs-REPLACE_INPUT' --client-token 'REPLACE_STABLE_INPUT_AP_TOKEN' \
  --posix-user uid=1000,gid=1000 --root-directory path=/ \
  --tags key=Owner,value=REPLACE_OWNER
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files create-access-point \
  --file-system-id 'fs-REPLACE_OUTPUT' --client-token 'REPLACE_STABLE_OUTPUT_AP_TOKEN' \
  --posix-user uid=0,gid=0 --root-directory path=/ \
  --tags key=Owner,value=REPLACE_OWNER
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files get-access-point \
  --access-point-id 'fsap-REPLACE'
```

Output root identity is confined to the owned output filesystem/AP, with matching
ClientRootAccess; input never gets write/root permission. It is not a container
privilege change or permission on another owner's data. Root-directory mapping,
POSIX behavior and input write denial still require a real mount test.

Fill the runtime policy's exact filesystem/AP values and attach it only after
reviewing the required GetAccessPoint/GetFileSystem/GetMountTarget/ListMountTargets
validation reads. The scoped metadata-resource forms in the examples have not
been live-qualified; if the service needs a broader resource scope, stop for an
explicit decision rather than copying the stock construct's `Resource: "*"`.
Imported-role deployment remains blocked until this authorization gate passes. Render the
input/output filesystem resource policies, then install and read back each one:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files put-file-system-policy \
  --file-system-id 'fs-REPLACE_INPUT' \
  --policy file://.deployment/reference/alice/input-filesystem-policy.json
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files put-file-system-policy \
  --file-system-id 'fs-REPLACE_OUTPUT' \
  --policy file://.deployment/reference/alice/output-filesystem-policy.json
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" s3files get-file-system-policy \
  --file-system-id 'fs-REPLACE'
```

These resource-policy examples are proposed isolation controls, not live-qualified
policies. They deny other mount principals, deny all NFS input writes/root access,
and allow only the owned AP. Direct S3 reads/writes are separately governed by
bucket and identity policies; POSIX controls do not secure S3 API access. Narrow
backing-role trust to its actual filesystem ARNs using the reviewed IAM
`update-assume-role-policy` command after creation. Do not remove synchronization
permissions or service-managed rules as a substitute for cleanup.

## 5. Bind the CLI project and review the actual deployment

In your private adopter checkout, fill `agentcore/aws-targets.json` with the one
approved target account/region. Replace the VPC, both subnets, per-owner runtime SG,
imported runtime-role ARN, and both AP ARNs in `agentcore/agentcore.json`. Use the
actual returned IDs, not the public examples. Keep `/mnt/home`, `/mnt/bma`,
`/mnt/output`, the supported environment variables and per-owner separation.
Do not commit your private receipts or credentials.

Continue with [the official CLI deployment guide](agentcore-cli.md), then
[validation, acceptance and troubleshooting](aws-validation.md). Do not create
Runtimes with the generic AWS `create-agent-runtime` command: runtime lifecycle
belongs to the official AgentCore CLI. Do not invoke generated `client.py`, which
can create/update a shared session role, or use `agentcore invoke` for extra paid
smoke turns outside the two-analysis allowance.

Sources: [S3 Files creation](https://docs.aws.amazon.com/cli/latest/reference/s3files/create-file-system.html),
[mount targets](https://docs.aws.amazon.com/cli/latest/reference/s3files/create-mount-target.html),
[access points](https://docs.aws.amazon.com/cli/latest/reference/s3files/create-access-point.html),
[filesystem policies](https://docs.aws.amazon.com/cli/latest/reference/s3files/put-file-system-policy.html),
[S3 Files IAM prerequisites](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html),
[AgentCore filesystem setup](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html).
