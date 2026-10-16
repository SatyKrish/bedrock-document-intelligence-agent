> Historical custom deployment path, retired on 2026-10-14. Use [the official AgentCore CLI path](../docs/agentcore-cli.md). Existing Phase A resources and receipts are preserved; do not replay these commands.

# Adopter-owned deployment

The guided deployment source is implemented and tested offline. It has **not**
built an image in AWS, provisioned infrastructure, run inference, connected a real
IdP, or installed a ChatGPT integration. Use this as a preview reference until the
live acceptance gates in [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md) pass.
Original project code is covered by [LICENSE](../LICENSE); third-party terms are in [NOTICE.md](../NOTICE.md).

The deployment runs entirely in your AWS account. It requires no author-owned
profile, network, bucket, endpoint, identity provider, Docker installation or
repository. The public example contains placeholders and `termsReviewed:false`.
Cloud writes, private image publication, a public HTTPS listener/DNS record, and
paid inference each need your organization's authorization before executing the
corresponding commands. Local source creation does not grant that authorization.

## Execution boundary

[BMA](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai.html)
manages model interactions and the Codex agent loop; its documented preview
requires a customer-provided execution environment. For AgentCore, the
[session contract](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-api-reference.html)
requires a runtime ARN. The [official runtime recipe](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-agentcore-runtime.html)
packages the separately acquired Linux ARM64 exec-server binary and adapter.
No default service-provisioned Codex executor is documented in the reviewed pages.
This application adds guards to that execution adapter and does not duplicate the
managed harness. A compatible, exclusively assigned existing runtime can be used
through the manual configuration path in [deployment.md](deployment.md); the guided
create-only path builds and owns new resources.

## Prerequisites and choices

- Node 24 LTS, npm, Python 3.13+ for runtime checks, Python 3.10+ for source ZIPs,
  and current AWS CLI v2. Install dependencies from the official npm registry.
- An existing approved CLI profile in your account, with explicit deployment
  permissions. The application uses different, scoped runtime identities.
- A supported BMA region (us-east-1, us-east-2, us-west-2) and Luna model access.
- An existing OIDC issuer/JWKS, public SPA client using code + S256 PKCE, exact
  MCP resource audience, and documents:read / analysis:write scopes.
- For hosted mode: an unused application hostname, an existing public Route53
  zone, issued ACM certificate in the same account/region, two enabled AZs,
  and an official Amazon Linux 2023 ARM64 EBS/HVM AMI. Preflight checks its
  owner, name, architecture and state. AL2 and generic ARM images are unsupported.
- One or two exact OIDC subjects and their synthetic document grants. Each gets
  exclusive AgentCore runtime, roles, buckets, filesystems and access points.
- Choose an explicitly reviewed existing network or a new two-AZ VPC with one
  NAT. Imported subnet/AZ/route identities are checked; endpoint policies,
  SG/NACL/DNS and actual reachability remain operator/live gates.

The tool does not create identity providers, clients, grants, domains or
certificates. It is a create-only workflow: changing identity, grants, network or
source under an existing deployment ID is rejected. Plan a separate deployment
and reviewed migration/revocation for those changes; it does not silently update
running resources.

## Configure and inspect

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run deploy -- init --config deploy/config.json
# Fill exact adopter values; review runtime terms and costs, then set termsReviewed:true.
npm run deploy -- preflight --config deploy/config.json
npm run deploy -- plan --phase build --config deploy/config.json
```

`preflight` performs read-only STS, model-catalog, network, AMI, certificate/DNS and
OIDC discovery checks. It neither grants permissions nor invokes a model. Apply
requires a successful matching preflight from the last 24 hours. Credentials
remain in your chosen provider chain, never configuration or archives.

A plan is local JSON at `.deployment/<id>/plan-build.json`. Review its complete
CloudFormation templates, IAM statements, source SHA-256, account/region,
configuration, cost allowance and retention policy. Its ID seals those contents;
`--approve` must match exactly and the plan expires after 24 hours. Regenerate and
review after any source/configuration change. The manifest
`deployment/source-files.json` lists every file uploaded; inspect it as part of
approval. Unlisted files, private config, state, profiles and vendor binaries are
not bundled. Archives are created fresh, deterministic and checked against the
approved source before upload.

## Build in AWS after approval

```sh
npm run deploy -- apply --config deploy/config.json \
  --plan .deployment/my-demo/plan-build.json --approve EXACT_BUILD_PLAN_ID
npm run deploy -- status --config deploy/config.json
```

The approved build stack creates a private versioned source bucket, immutable
scan-on-push ECR repositories, bounded log group and a dedicated CodeBuild role.
One native ARM on-demand build runs outside your VPC, with concurrency one and a
30-minute timeout. It has no model/session/deployment permissions. Source/object
version, official archive/binary hashes and offline protocol tests are checked.
Executor version/help/HTTP boot and compiled mock-app boot checks run without
container networking. Only passing images are published to your private ECR.
The result records immutable image digests tied to the source SHA.

[CodeBuild documents Docker availability for non-VPC builds](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html).
The source uses the managed Amazon Linux ARM image and `privilegedMode:false`.
This exact job has not run; image/daemon behavior, quotas, dependency installation,
resolved base provenance and scan review are release gates. A failure does not
automatically enable privilege, retry a paid job, or alter local Docker contexts.

## Deploy and verify readiness after separate approval

```sh
npm run deploy -- plan --phase deploy --config deploy/config.json
# Review new storage/runtime/app templates, image digests and persistent costs.
npm run deploy -- apply --config deploy/config.json \
  --plan .deployment/my-demo/plan-deploy.json --approve EXACT_DEPLOY_PLAN_ID
npm run deploy -- status --config deploy/config.json
```

The hosted path creates the network/foundation, isolated principal silos, and
application host. Skills are seeded into the new input buckets directly by the
approved operator step; there is no seed Lambda in this path. The app role cannot
change skills. Input mounts are read-only; output access is writable only on its
own access point. Downloads still require S3 availability and content/seal checks.

The application uses private ARM EC2, an encrypted retained EBS state volume,
IMDSv2, SSM configuration, a digest-pinned app container and nginx. An ALB supplies
HTTPS and an approved-zone DNS alias. Only the ALB SG reaches nginx; it overwrites
the client-IP header used by the app's limiter. The container's listener is
published only on host loopback. SQLite is single-process durable state. Boot
refuses a missing/mismatched state disk; it cannot fall back to ephemeral state.
This is a small alpha deployment, not high availability or a backup/restore system.

CloudFormation completion is not application readiness. `status` checks HTTPS,
live-mode configuration and the anonymous authentication challenge. Sign in via
the actual IdP, verify document grants, and follow [chatgpt.md](chatgpt.md). No real
tokens or private request bodies are printed. Hosted boot and OAuth remain live
gates until tested in the adopter's account.

## One authorized synthetic smoke run

Provide a short-lived access token for the configured subject through a protected
process environment as `DOCINTEL_SMOKE_TOKEN`, never a CLI argument or repository
file. That subject needs all three fixtures. Do not paste tokens into shell history.

```sh
npm run deploy -- smoke --config deploy/config.json \
  --plan .deployment/my-demo/plan-deploy.json --approve EXACT_DEPLOY_PLAN_ID
```

This command can consume paid resources. It submits one comparison with a durable
UUID, polls for up to five minutes, and downloads sealed Markdown/CSV through the
same authorized application API. A lost submission is reconciled from owned
history without another inference. At the deadline it requests cancellation;
that acknowledgement is not terminal confirmation. The allowance is **not** an
enforced AWS dollar cap. Review actual grounding, reconnect/cancellation, mount
isolation and real ChatGPT connection separately after the smoke succeeds.

## Retain-data teardown after approval

```sh
npm run deploy -- plan --phase cleanup --config deploy/config.json
# Review exact stack IDs, templates, parameters, physical resources and retained data.
npm run deploy -- cleanup --config deploy/config.json \
  --plan .deployment/my-demo/plan-cleanup.json --approve EXACT_CLEANUP_PLAN_ID
```

Cleanup rechecks the material snapshots before destructive operations, persists a
retained-resource manifest, stops hosted admission first, cancels only sessions
with a confirmed exclusive runtime/role pair, verifies terminal state, and stops
any recorded active build before deleting owned stacks. Unknown ownership shapes
or changed resources halt cleanup. Imported network, certificate, zone and IdP
are preserved. Data buckets/S3 Files/access points/backing roles, application state
EBS, source bucket, images and build logs remain retained and billable. There is
no automated data purge. Review mounts, versions, snapshots, roles and dependencies
before a separately authorized deletion of retained data.

Incomplete failed silo stacks without confirmed runtime/role outputs deliberately
halt automated cleanup before any mutation. An operator must inspect the exact
recorded stack ID/resources and current BMA ownership with read-only AWS tooling,
confirm sessions are stopped, then approve a specific manual recovery/deletion.
Never infer ownership from a missing ARN or broaden cleanup to account-wide work.
This failure recovery and actual teardown behavior still require live qualification.

## Developer mode and recovery

Set `mode:developer` and an exact existing `developerCallerArn`; no ALB/app/DNS/EBS
is created. That role must already be authorized to assume only the planned silo
app roles. Use generated `silos.json` and `acl.json`, configure the live variables
in [deployment.md](deployment.md), and run local UI/API behind your approved HTTPS
origin. Hosted mode is the main ChatGPT walkthrough; localhost alone is not
reachable from ChatGPT web. For teardown stop all developer UI/API/MCP processes
first and add `--quiesced` as your explicit stop assertion.

An exclusive local lock prevents concurrent apply/smoke/cleanup operations. A
crash leaves a lock; verify the process has stopped before removing a stale lock.
State records pending writes before sending them. A lost create/build/delete
response blocks another write. `status` is read-only and shows recorded IDs and
pending operations even after stack deletion. Use exact CloudFormation events,
CodeBuild ID/status and BMA session metadata to reconcile with operator review.
Do not erase state, change deployment IDs to retry paid work, or clear pending
records on assumption. Automatic ambiguous-write reconciliation/migration is not
implemented; preserve journals and manifests for manual recovery.
