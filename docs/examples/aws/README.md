# Generic policy examples

These JSON files are documentation/preparation assets. They have not been applied
to AWS or qualified with live mounts. They contain unresolved `__TOKEN__` values,
not working account resources. Render separate private copies for Alice and Bob;
never apply the example files directly. See [the complete setup order](../../aws-prerequisites.md).

| Role             | Trust file                     | Permissions file                | Boundary                                                                           |
| ---------------- | ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------- |
| Application      | application-trust.example.json | application-policy.example.json | Approved backend/operator role; owned input staging/output reads; one session role |
| BMA session      | session-trust.example.json     | session-policy.example.json     | BMA service in this account/region; GPT-6 Luna only; one Runtime and endpoints     |
| Runtime          | runtime-trust.example.json     | runtime-policy.example.json     | AgentCore service in this account/region; owned image/logs/mounts                  |
| S3 Files backing | s3files-trust.example.json     | s3files-policy.example.json     | EFS service on behalf of owned S3 Files filesystems; owned bucket synchronization  |

Replace account, region if approved, bucket names, role names, operator role ARN,
Runtime ARN/source ARN/log prefix, CLI ECR repository name and both filesystem/AP
IDs. The runtime name in the native dry-run determines its expected log/source
prefix. The source trust values must be reviewed ARN patterns/arrays, not an
unrestricted `*`. Resolve actual Runtime and filesystem ARNs once created and
narrow temporary trust patterns using `iam update-assume-role-policy` with the
rendered document. Never use the operator's administrator credentials as a
Runtime or session role.

Use separate `bucket-policy` copies per bucket. The other three bucket JSON
examples contain no private identifiers and can be supplied directly after
review. The two filesystem policies are additional proposed resource policies:
other NFS mount principals are explicitly denied, and the input policy denies
write/root access to everyone. The owner's runtime identity policy additionally
requires its own AP ARN. Control-plane policy management remains an operator
permission, not an agent permission. S3 API access is a separate IAM boundary.

The S3 Files backing role can synchronize changes, including deletions, inside
its owner's two dedicated buckets. These service permissions do not authorize an
operator cleanup purge. Its EventBridge management statement is constrained to
S3 Files-managed rules in this account/region. Regional rule enumeration uses
`Resource: "*"`, with an explicit region condition, because list operations do not
provide the same resource boundary as individual rule operations. If current
service requirements differ, stop and review the change rather than adding full
EventBridge/S3 access.

The runtime `GetAccessPoint` statement lists only the two owned filesystem/AP ARN
pairs for documented access-point validation. The example additionally includes
GetFileSystem, ListMountTargets and GetMountTarget, which the native construct
identifies as Runtime-creation validation reads. Their proposed owned-filesystem
resource scoping is not live-qualified, especially for target/list operations.
Imported-role deployment is blocked until the current service accepts the exact
scoped reads; if an action requires broader metadata access, obtain explicit
approval instead of copying the stock `Resource: "*"`. Mount/write permissions have
separate mandatory AP conditions. No `ClientWrite` or `ClientRootAccess` is granted
on input. Direct S3 reads are scoped to owned buckets, since S3 Files can service
reads through S3. The runtime has no direct S3 write or BMA session-read API grant.

ECR performs KMS encryption through its service grants. Do not solve an image-pull
error with a blanket runtime `kms:Decrypt` grant. Review the exact generated
repository key/grants and [ECR KMS requirements](https://docs.aws.amazon.com/AmazonECR/latest/userguide/encryption-at-rest.html).
If an additional grant proves necessary, bind it to the one actual key and review
it as part of the deployment; do not pre-authorize every account key. Generated
construct defaults are not permission changes to imported immutable roles.

The preview's application-session and environment-registration permissions use
`project/*` in one account/region. This is not per-user BMA session authorization.
Only the trusted application/operator may hold these credentials. End users reach
JWT-authenticated domain services, which enforce session ownership on every HTTP
and MCP request. Direct AWS credentials cannot be given to users as an alternative
to that boundary. Real user isolation must be tested through those services as
well as S3/runtime boundaries; an IAM simulator alone is insufficient.

`CreateInference` uses `Resource: "*"` with the exact `bedrock-mantle:Model`
condition because the preview does not authorize it through a model ARN. The
session role does not grant Gateway invocation, other models or other Runtimes.
Application `PassRole` names one session role and the BMA service. The sample
application policy omits account-wide session listing/deletion because normal
analysis reconciliation does not require it. Approved operator cleanup has its
own exact resource/session inventory.

Before applying, parse each private JSON, check no tokens remain, inspect every
Action/Resource/Principal/Condition and use IAM Access Analyzer policy validation
if authorized. Validation warnings and missing context are review inputs, not a
reason to broaden policies. After applying, read back trust/inline/resource
policies and record hashes. Run positive and cross-owner deny checks using the
actual assumed-role identities before model invocation.

Sources: [BMA identities and PassRole](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-security.html),
[S3 Files IAM prerequisites](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html),
[Runtime mount permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html).

## Native CLI roles and operator permission review

The stock generated stack creates two CodeBuild roles and two Lambda handler
roles, in addition to the eight separately prepared owner roles. Inspect the
actual synthesized policy documents: builder access includes the bootstrap asset
bucket, its owned ECR repository, logs, registry authorization and VPC ENI APIs.
Lambda handlers start/read their native builds and use the stock Lambda VPC
execution policy. Some registry/discovery/ENI actions are not resource-scoped to
one image or ENI. These are disclosed stock defaults, not a claim that every
native permission is owner-scoped. Review them before deployment; do not broaden
imported application/session/runtime roles to mirror builder permissions.

The provisioning operator needs approved IAM role/policy/PassRole, private S3,
S3 Files, EC2 security-group/ENI, CloudFormation, CodeBuild, Lambda, ECR, KMS and
log operations for the reviewed resources. Existing bootstrap deploy/lookup/file
publishing roles are separate existing access. The guide does not create an
administrator policy or alter an existing shared SSO/operator role. New bootstrap
resources, service-linked roles, key/grant changes or broader metadata reads need
explicit scope review.
