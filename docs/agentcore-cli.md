> First live gate: [AWS NAT/sample baseline](aws-baseline.md), using the official
> CLI and unchanged lifecycle. The `/mnt/home` document profile below is a later
> product profile, not the initial stock-sample acceptance configuration.

# Official AgentCore CLI deployment

The canonical AWS path is `@aws/agentcore@0.31.1`. The reference project at
`agentcore-reference/DocIntelReference` was generated with `agentcore create` and
`agentcore add agent`, using `BedrockManagedAgents`. Its Alice and Bob lifecycle
files remain unchanged. The project CDK policy explicitly retains resources,
removes build-only VPC attachment and narrows source reads. The earlier custom
`deployment/cli.ts` entrypoint is retired; do not replay historical scripts.

Start with [prerequisites](aws-prerequisites.md), then
[validation/recovery](aws-validation.md). These commands require an adopter's own
reviewed identities, resource plan and authorization. Native image builds and
Runtime creation were observed in a bounded synthetic test, but managed registry
activation failed with HTTP 500. No live document report was produced. See
[validation status](validation-status.md). The public examples are not deployed
resources, deployment receipts or approval for any account.

## Local preparation

Use Node 24 LTS and npm. Install from the official npm registry:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run baseline:prepare -- --download
npm run agentcore -- validate --json
npm run typecheck
npm test
npm run build
```

The CLI is a local development dependency, not a global installation. Container
Python is part of AWS's generated runtime. Python/uv on the developer host is
needed only for optional sample-client or dependency-lock maintenance, not the
TypeScript application or CLI generation with `--skip-python-setup --skip-install`.
The TypeScript app uses Node's built-in SQLite; its Docker builder has no Python
installation. Complete app and packaging tests run separately before building.
Actual absence of Python in a newly shipped app image remains a container check.

The public `agentcore/aws-targets.json` is intentionally empty. VPC, security-group,
access-point and imported-role identifiers in `agentcore.json` are examples,
not existing or authorized resources. Configuration validation does not prove
resource existence or IAM/mount behavior. Never deploy these placeholders.

To reproduce generation in a separate destination, use the official CLI:

```sh
npx --no-install agentcore create --name Alice --project-name DocIntelReference \
  --framework BedrockManagedAgents --session-storage-mount-path /mnt/home \
  --skip-git --skip-python-setup --skip-install --output-dir /your/new/directory
# From that generated project:
npx --no-install agentcore add agent --name Bob --framework BedrockManagedAgents \
  --session-storage-mount-path /mnt/home
```

## Configuration and application connection

Use the generated `agentcore/.llm-context/agentcore.ts` types and official
`agentcore validate`. Configure two separate runtimes with:

- Existing approved VPC/private subnets and dedicated scoped security groups.
- `executionRoleArn` pointing to each owner's reviewed runtime role. This imports
  roles without the CLI's broader default model/configuration-bundle grants.
  Grant registration/connection, ECR pull and required logs only, plus each owner's
  exact S3 Files access points. Input mounts get ClientMount only; output writes
  and ClientRootAccess, if required by its POSIX mapping, apply only to that owner's
  output access point. The generated runtime does not enforce application ACLs.
- Session storage at `/mnt/home`, `BMA_HOME_DIR=/mnt/home`, state at `/mnt/home/.bma`
  and Codex home at `/mnt/home/.codex`; the app uses `/mnt/home/workspace`.
- S3 Files input/output mounts at `/mnt/bma` and `/mnt/output`. Staging remains
  `inputs/<analysisId>/`; outputs remain `<analysisId>/`. The application waits for
  HEAD/GET availability and verifies content seals before granting downloads.
- Image plugin discovery at `/opt/bma/plugins`, including the supplied document
  analysis and generate/examine/correct skills. No custom lifecycle monkeypatch or
  skill-copy daemon is used. S3-mounted skills can use a separately configured
  capability directory under the documented plugin layout.

Use the official CLI for AWS lifecycle operations after approval:

```sh
npm run agentcore -- deploy --target test --dry-run --json
npm run agentcore -- deploy --target test
npm run agentcore -- status --target test
npm run agentcore -- logs --since 15m
```

Do not add `--yes` to an unreviewed dry run: CLI 0.31.1 can auto-bootstrap before
returning its dry-run result. Inspect CLI behavior and bootstrap prerequisites
before using even a dry run. Bind actual security groups, access points and roles
only in a private operator copy; keep public targets empty.

The root npm command sets `AGENTCORE_CONFIG_DIR` to this project's `cli-settings`
directory. CLI source supports this override; it avoids editing `~/.agentcore`.
`disableTransactionSearch:true` is the documented opt-out. Runtime OTel is also
disabled through supported settings. These do not suppress ordinary runtime logs.
CLI-generated installation IDs are local metadata; never store AWS credentials or
real OAuth tokens here. No account-wide Application Signals/Transaction Search
setup, shared role helper, OAuth client or public endpoint is authorized.
Always use the root npm entrypoint for deployment; bare commands from the generic
generated README do not select this project-scoped opt-out.

Use `agentcore status` outputs to configure the TypeScript application's private
`SILOS_FILE`, mapping each authenticated subject to exclusive Runtime, application
role, session role and buckets. Select `openai.gpt-6-luna` in us-east-1. The app
uses raw documented SigV4 BMA REST, not the optional Python sample client. Never
run generated `client.py` without explicit authorization: its default creates or
rewrites the shared `BmaSessionRole-<region>` role. Dedicated session roles must
scope inference to the selected model and activation/stop to the owned Runtime.

## Provenance and validation gates

`PROVENANCE.json` records npm integrity and lifecycle SHA256. Dockerfile changes
only pin official build inputs: AWS base and uv image digests, Codex 0.154.0,
Python 3.13.16 and CloudWatch RPM content. `uv.lock` records Python dependencies.
The CloudWatch URL is mutable; unexpected content fails its SHA256 check. Pinning
is not evidence of vulnerability remediation. The old image findings remain
unwaived; the new exact digests have completed ECR basic scans with zero findings.
Basic scans do not cover every language dependency or embedded binary.

Stock CLI deployment combines CodeBuild image creation and Runtime provisioning;
it does not wait for image scan review. Any plan permitting uninvoked Runtime
creation before qualification must state that sequence explicitly. Keep managed
session activation and model turns gated on qualification of the exact image.

The included project policy retains non-metadata template resources on deletion
and replacement, disables ECR automatic expiry/empty-on-delete and removes
explicit log expiry. Builders use AWS-managed networking. This is a generated
project customization, not a native CLI retention switch. Review the synthesized
template and ownership before deployment. AWS S3 Files uses an account-wide managed
EventBridge rule; never rewrite or remove that shared rule during reference cleanup.

Imported roles are immutable to the generated construct: it does not automatically
add ECR/KMS or S3 Files grants to them. Verify their exact policies, input
read-only mounts, owner-specific output writes and cross-owner denial before
creating or using Runtimes. Placeholders cannot provide that evidence.

Runtime IAM calls are a service/operator boundary. End users reach only the
JWT-authenticated TypeScript app/MCP surface; they must not receive direct Runtime
invocation or imported runtime-role credentials. Synthetic fixtures only are
permitted for the initial live check. Ordinary runtime logs can contain harness
stdout; preserve them privately and assess retention before customer data use.

## Identity plan

Use a new isolated test identity setup as the reference example, with provider-neutral
application authentication. [Identity planning](identity-plan.md) records the
Cognito candidate, separate web/ChatGPT clients and unresolved compatibility
gates. This planning selection does not authorize resource/client/grant creation.
Identity and hosted-web costs are outside the runtime-only reservation below.

## Cost and cleanup

The example document profile sets a 600-second idle timeout and 1,800-second
maximum compute lifetime. These controls do not cap total session time or cost.
Prepare a current regional estimate for native ARM builds, runtime compute, model
usage, S3 Files traffic/cache, S3 requests, keys, images, logs, network egress and
retained data. Retries and replacement compute can exceed an initial reservation.
The separate [baseline cost example](aws-baseline.md#cost-and-remaining-live-gates)
is illustrative and does not authorize a run. Identity and hosted web costs must
also be estimated if included.

Keep a private ownership ledger with exact physical resource IDs and source/image
digests. Stop owned sessions and builds, reconcile output availability, then follow
the operator's explicit retention or deletion scope. The included CDK retention
policy means stack deletion can leave chargeable resources behind. Verify actual
absence or retained-resource disposition; a successful delete request is not proof
of cleanup. Never delete shared account services or unrelated resources. Deleting
stored data, keys or images requires an explicit operator decision. The stock CLI
has different destructive defaults, so inspect the final template and do not
substitute generic `agentcore remove all` examples for a reviewed cleanup plan.

Sources: [AWS BMA quickstart](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-bma.html),
[AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/),
[S3 Files pricing](https://aws.amazon.com/s3/pricing/#Files),
[CodeBuild pricing](https://aws.amazon.com/codebuild/pricing/),
[KMS pricing](https://aws.amazon.com/kms/pricing/).

For the trusted local synthetic operator path, see [headless Runtime acceptance](runtime-acceptance.md).

CLI 0.31.1 prints a Transaction Search success note even when the project
`disableTransactionSearch:true` opt-out returns before the setup helper. The
scoped run verified that source path and kept the opt-out. The note alone is
not evidence that account-wide Transaction Search was enabled.
