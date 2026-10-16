> Initial live acceptance is now [hello-bma then verification.txt](aws-baseline.md).
> Complete that stock-sample gate before the document-report runner. The prior
> registry failure and removed PrivateLink endpoints remain historical evidence.

# AWS deployment validation, acceptance and recovery

Follow [prerequisites](aws-prerequisites.md) and the [official CLI guide](agentcore-cli.md)
in order. All cloud commands below are operator instructions for a separately
approved deployment. They were not executed while writing this guide. The
retired `deployment/cli.ts`, old custom stack commands and old live-readback
controller do not own a canonical CLI deployment.

## What has actually been tested

Current local evidence: typecheck/production build, 70 mock/offline tests across
15 files, formatting and plugin source packaging passed. Six earlier rendered
mock desktop/mobile UI workflows passed. See [VALIDATION](../VALIDATION.md).

The separately approved canonical CLI run completed its dedicated network and
S3 Files prerequisites, two native builds and two READY Runtimes. Exact-digest
ECR basic scans and independent static RPM/PyPI/source checks qualified only the
bounded synthetic test. The first BMA session was created, but the stock exec
server repeatedly received registry HTTP 500. No output was produced and Bob
never started. Cancellation and authoritative Runtime stop were acknowledged;
all four interface endpoint deletions are verified complete in the [dated execution record](validation-status.md).
Input submission/model usage remains uncertain; no input was replayed.

This does not validate real report quality, NFS denial, complete S3 output sync,
hosted JWT/PKCE or ChatGPT connectivity. Historical custom-path images remain
outside native qualification and their findings remain unwaived. Temporary
official AWS CLI 2.38.1 supports the live S3 Files operations; system CLI 2.34.20
does not. Runtime-only acceptance uses the [trusted local runner](runtime-acceptance.md).

## Before any build or deployment

1. Record an explicit approval that covers the exact resource inventory, imported
   policies, privileged CodeBuild, two serial synthetic analyses, cost reservation
   and failure/retention behavior. Do not reuse a historical source hash or approval
   packet from the custom deployment path.
2. Verify both named-profile AWS CLI and Node provider-chain caller identity
   before native commands; account, region and full approved caller ARN must match.
   Then verify source/lifecycle/CDK provenance, all actual resource IDs,
   distinct owners, real APs, read-only input/writable output policies, approved-subnet/AZ
   readiness, security-group rules and exact role trust. Public placeholders must
   not survive. Validate all local JSON and run `npm run agentcore -- validate --json`.
3. Run the native dry run/diff without `--yes`, against existing approved bootstrap
   resources. Review resource and IAM changes, CodeBuild privilege/timeout/VPC,
   image inputs, session lifetime, deletion/replacement and rollback behavior.
   A missing bootstrap can itself require writes; stop instead of auto-accepting.
4. Confirm the scan sequencing decision. Stock CLI creates images and Runtimes in
   one deployment, with no scan-review barrier. Provisioned-but-uninvoked Runtimes
   require explicit approval if scan-before-creation was previously required.
5. Confirm retain-data failure handling. The generated ECR/KMS policies are
   destructive on removal/replacement. A failed stack creation/rollback can also
   remove resources; the exposed CLI 0.31.1 flags do not provide a verified
   retain-on-failure option. Do not assume the happy-path cleanup promise covers
   rollback. Resolve that gate before a first deployment, without modifying the
   generated CDK or bypassing the CLI.
6. Recalculate the full cost reservation, including retained resources. Confirm
   the operator can map and stop the exact Runtime sessions before starting work.
   CLI `pause` supports evaluations/A-B tests, not runtime compute shutdown.

## Native deployment and image qualification

Run only the official CLI after those gates pass. Capture structured output and
private logs in a new receipt directory; do not log environment credentials.

```sh
npm run agentcore -- deploy --target test --dry-run --json
npm run agentcore -- deploy --target test --diff --json
# Approved write; do not run while approval/security gates are pending:
npm run agentcore -- deploy --target test --json
npm run agentcore -- status --target test --json
npm run agentcore -- logs --runtime Alice --since 15m --limit 50 --json
npm run agentcore -- logs --runtime Bob --since 15m --limit 50 --json
```

Do not add manual CodeBuild jobs or a custom image publisher. Preserve the native
stack/template/asset manifest, CLI/CDK versions, source hashes, build IDs and
image digests. If deployment response is ambiguous, read CloudFormation events,
CodeBuild state and CLI status before any retry. A build still running after a
CLI/CloudFormation error can continue billing. Do not restart deployment merely
to obtain a cleaner success response.

Read each actual repository/digest from CLI/stack output, then inspect it:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ecr describe-images \
  --repository-name 'REPLACE_ACTUAL_REPOSITORY' \
  --image-ids imageDigest=sha256:REPLACE_ACTUAL_DIGEST
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" ecr describe-image-scan-findings \
  --repository-name 'REPLACE_ACTUAL_REPOSITORY' \
  --image-id imageDigest=sha256:REPLACE_ACTUAL_DIGEST
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" codebuild batch-get-builds \
  --ids 'REPLACE_RECORDED_NATIVE_BUILD_ID'
```

Use the scan result matching that exact digest and creation time. Pending,
unsupported, failed or unavailable scan status is not a clean scan. Review all
HIGH/CRITICAL findings and fix or obtain a specific documented security decision;
deployment approval does not waive earlier or new findings. A base-image pin or
successful build is not a fix. Verify Linux ARM64, stock lifecycle boot, expected
Codex binary/version and dependency provenance, and review native image logs.
A package scan does not cover every statically linked component. Do not execute
unsafe images to see whether a vulnerability is reachable. No extra model smoke
turn is needed to inspect ECR/CodeBuild evidence.

After creation, fill the session-role policy with the exact owned Runtime ARN and
attach it, bind the application policy to its exact session role, and narrow role
trust patterns to their actual resource ARNs. Read back all policies. If any
required change broadens the approved role/resource scope, stop for review.

## Application configuration

Copy [infra/silos.example.json](../infra/silos.example.json) to a private file.
Use each actual Runtime ARN, session role, application role and owned bucket pair;
choose `openai.gpt-6-luna` in the supported us-east-1 account catalog. Real signed
catalog access must confirm model availability before invoking it. Do not infer
availability from a generic model card or fall back to another model silently.

Map exact authenticated OIDC subjects in both the silo file and an ACL file:

```json
{
  "REPLACE_ALICE_SUBJECT": ["acme-2024", "beta-2024", "kpis-2024"],
  "REPLACE_BOB_SUBJECT": ["acme-2024"]
}
```

For the web/MCP service, use an already approved HTTPS origin/issuer/client. An
isolated provider is recommended for an eventual hosted reference, but provider,
client, DNS/TLS/public hosting and grants are a separate approval. See
[identity planning](identity-plan.md) and [ChatGPT setup](chatgpt.md). Current
Cognito scope names need an application mapping before direct compatibility can
be claimed. Do not use mock bearer tokens in live mode.

The full application environment is:

```sh
export MODE=bedrock
export LIVE_AWS_CALLS=approved
export AWS_PROFILE="$DOCINTEL_PROFILE"
export AWS_REGION=us-east-1
export SILOS_FILE='/absolute/private/silos.json'
export CATALOG_ACL_FILE='/absolute/private/catalog-acl.json'
export STATE_FILE='/absolute/private/live-state.sqlite'
export PUBLIC_ORIGIN='https://your-approved-app.example'
export OIDC_ISSUER='https://your-approved-issuer.example'
export OIDC_JWKS_URL='https://your-approved-issuer.example/.well-known/jwks.json'
export OIDC_AUDIENCE='https://your-approved-app.example/mcp'
export OIDC_CLIENT_ID='your-approved-public-spa-client'
export OIDC_CONNECT_ORIGINS='https://your-approved-issuer.example'
# Optional parser feature; no additional inference request or hidden reasoning:
# export BMA_PUBLIC_SUMMARIES=conservative-preview
npm run build
npm start
```

These environment values are examples, not a working hosted identity deployment.
OIDC discovery/token/JWKS origins may differ; allow only the exact approved HTTPS
origins required by the provider. Access tokens remain in memory. Backend master
credentials must assume only the two approved application roles. A trusted
operator may exercise domain services headlessly for runtime qualification without
publishing an endpoint, but that is not evidence of browser/JWT/ChatGPT acceptance.
A dedicated live headless runner has not yet been qualified in this repository;
do not replay the retired custom deployment smoke controller as a substitute.

## Two-analysis acceptance matrix

Use at most two new live analyses, serially, after qualification. Record each
request UUID before sending; retry only the same UUID with the identical payload.
Reconcile a lost response using durable app state. Never clear the database or
invent a new UUID to repair an uncertain paid write. Retain the analysis ID,
BMA session ID, turn ID and confirmed Runtime-session mapping privately.

| Case  | Selection and question                                                                           | Expected evidence                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alice | ACME/BETA reports + KPI CSV; compare 2024 revenue and operating margins, identify missing EBITDA | ACME revenue 94.2 and operating income 21.6; BETA 212 and 64 (USD billions); derived margins about 22.93%/30.19%; source quotes and explicit missing-EBITDA limitation |
| Bob   | ACME report only; summarize its 2024 revenue, operating income and source limitations            | ACME-only citations and owned Markdown/CSV; no BETA or KPI dataset access                                                                                              |

For both cases, observe staged `inputs/<analysisId>/manifest.json` and selected
file SHA256s, document skill use, generate/examine/correct behavior, and final
`result.json` written after reports. Compare citations with selected source bytes
and re-open Markdown/CSV. Check numeric rows and source IDs, plus narrative meaning
and unsupported claims manually. `completed` alone is not semantic correctness.
Verify outputs are unavailable until S3 HEAD/GET and content seals pass; later
reads must recheck the seal. Keep raw source/report evidence synthetic.

Negative checks should fail before creating another analysis/model turn: Bob's
BETA/KPI selection, reading/cancelling Alice's analysis, listing/downloading her
artifacts, and read-only scope attempts to start/cancel. Test through both HTTP
and MCP when approved real tokens are available. Independently assume each owned
application role for S3 cross-owner GET/PUT-denial checks; use approved synthetic
canaries in owned buckets, never real data. IAM simulation is supplementary and
does not prove a mount or a real API denial.

Close/reopen the connection and recover from the same durable analysis; a browser
or SSE disconnect must not create another provider turn. A known-session process
restart must reconcile read-only. Record actual terminal state and session mapping,
not just an HTTP acknowledgment. Live active-turn cancellation remains a separate
coverage item if it cannot be exercised within the two approved report runs;
do not create a third turn to manufacture coverage. Unit/mock cancellation tests
are not live cancellation evidence.

For public reasoning summaries, default disabled must expose no stored summary.
If the conservative parser is approved/enabled, inspect only already-created
sessions' documented public summary items; accept `unavailable` for absent or
unknown envelopes. Verify turn/item ownership, bounded text and no raw/encrypted
reasoning persistence. Do not request hidden reasoning or use a Responses API
summary knob. Record observed public schema, not a claim that summaries always
exist. See [summary behavior](reasoning-summaries.md). Reading the same session
again must not trigger a new inference.

## Retain-data stop, failure handling and costs

Stop admission to new analyses first. Cancel only recorded owned work through the
application and verify the BMA terminal acknowledgment. Cancellation does not
prove Runtime termination or S3 synchronization. Resolve the actual AgentCore
Runtime-session ID from authoritative response/log evidence; do not assume it is
the BMA session ID. Stop only that runtime/session/qualifier mapping:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" bedrock-agentcore stop-runtime-session \
  --agent-runtime-arn 'REPLACE_OWNED_RUNTIME_ARN' \
  --runtime-session-id 'REPLACE_CONFIRMED_RUNTIME_SESSION_ID' --qualifier DEFAULT
```

This official AWS data-plane stop is separate from CLI-managed infrastructure.
Record the stop response, terminal/idle evidence, bounded polling and final log
window. If the mapping or stop outcome is uncertain, stop new starts and escalate;
keep the 600-second idle/1,800-second maximum lifetime as a fallback rather than
claiming a monitor timeout stopped compute. If an approved native build is still
running, stop only its recorded build ID, then confirm terminal status:

```sh
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" codebuild stop-build \
  --id 'REPLACE_RECORDED_NATIVE_BUILD_ID'
aws --profile "$DOCINTEL_PROFILE" --region "$DOCINTEL_REGION" codebuild batch-get-builds \
  --ids 'REPLACE_RECORDED_NATIVE_BUILD_ID'
```

Confirm output export with S3 HEAD/GET, retain hashes and artifacts, and inventory
all physical resources, policies, image digests, build logs and local state. Stop
is a compute operation; it must not delete files, buckets, images, logs or keys.
Do not run `agentcore remove all`, resource renames/replacements, stack deletion,
ECR purges, versioned-bucket emptying or KMS deletion under retain-data approval.
The native Lambda handler log groups expire records after 731 days; CodeBuild
logs may have a different/default retention. Record each actual setting. These
stock policies do not implement indefinite evidence retention; export required
logs privately before expiry and obtain approval for any retention change.
Stock ECR expires images beyond ten, so do not cross that threshold even if the
stack is retained. Managed session storage is not an archive: runtime version
updates/deletion and preview idle-expiry rules can reset it. Preserve deliverables
in verified customer-owned S3 outputs before any future update/removal.

[The cost reservation](agentcore-cli.md#cost-and-retain-data-stop) includes
privileged builds, Runtime consumption, two GPT-6 turns, S3 Files, retained KMS/ECR
and a request/log/network reserve. The $4.374 example is an estimate within a $5
operational boundary, not a service-enforced dollar cap. Record actual rounded
CodeBuild minutes, model usage if returned, Runtime/log metrics, storage bytes and
uncertainties. Billing/usage can lag; stop on an approaching forecast, unexpected
build retry, unsupported resource shape or unplanned paid component. Retained
resources continue billing. Hosted identity, public endpoints and new NAT/fleet
capacity are excluded and require another cost plan. No automatic future purge
or resource-deletion authorization is implied.

## Troubleshooting

| Symptom                                                 | Action                                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS CLI rejects `s3files`                               | Update through official verified AWS distribution after approval; run local skeleton capability checks; never invent SDK wire compatibility                          |
| AWS CLI STS succeeds but Node CLI reports expired SSO   | Stop for operator auth handoff or an approved temporary in-memory credential launch; do not log/export credentials to disk, create keys or rewrite shared SSO config |
| CLI wants bootstrap/account-wide Transaction Search     | Stop if unapproved; preserve project-scoped `AGENTCORE_CONFIG_DIR` opt-out; runtime OTel flags alone do not disable account setup                                    |
| Imported runtime role cannot pull/log/mount             | Read exact policy/resource/trust and ECR service key grants; immutable import does not add grants; do not attach full-access policies                                |
| NFS/mount times out                                     | Check same VPC/AZ targets, owned SG pair TCP2049, readiness, AP ARN/condition and POSIX mapping; do not add public NFS or shared-group ingress                       |
| Source appears missing or output is late                | Reconcile manifest/checksums and asynchronous S3 Files import/export; bounded retries, no extra model turn; never mark download ready from a listing alone           |
| CLI/CFN error while build continues                     | Read native events/build ID; no blind deploy retry; stop the exact owned job if approved; preserve evidence and retention gates                                      |
| ECR scan is unsupported/pending or finds HIGH/CRITICAL  | Keep execution blocked; review exact digest and remediate/obtain specific decision; deployment approval is not a waiver                                              |
| `uncertain` / lost submit acknowledgment                | Reconcile known provider IDs using reads; no new request UUID or paid replay; a monitor timeout does not stop AWS work                                               |
| JWT `401` / scope `403`                                 | Check exact issuer/audience/expiry/JWKS/scopes and resource metadata; Cognito prefixed scopes need mapping; never relax validation or use demo tokens                |
| `agentcore pause` does not stop Runtime                 | Expected in 0.31.1; use approved exact owned Runtime-session stop and verify it; no stack removal                                                                    |
| Cannot retain artifacts through native removal/rollback | Remains a deployment gate; do not edit generated CDK, schedule KMS deletion or delete evidence to finish a test                                                      |

Sources: [BMA security](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-security.html),
[official CLI BMA lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-bma.html),
[ECR scan results](https://docs.aws.amazon.com/cli/latest/reference/ecr/describe-image-scan-findings.html),
[Runtime-session stop](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore/stop-runtime-session.html),
[CloudFormation failure options](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stack-failure-options.html).
