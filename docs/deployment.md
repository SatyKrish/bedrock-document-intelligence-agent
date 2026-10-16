> Historical custom deployment path, retired on 2026-10-14. Use [the official AgentCore CLI path](../docs/agentcore-cli.md). Existing Phase A resources and receipts are preserved; do not replay these commands.

# Deployment and application configuration

Use the [guided adopter walkthrough](open-source-deployment.md) for the main
AWS-side build, hosted UI/API/MCP, smoke and retain-data cleanup path. The source
is offline-tested; no live deployment or identity flow has been qualified.

## Manual existing-runtime/developer path

A compatible, exclusively assigned AgentCore runtime and S3 Files storage can be
configured through `infra/silos.example.json`; import of existing execution
resources into guided lifecycle ownership is not automated. Each exact OIDC
subject must have separate runtime, session/app roles and input/output buckets.
Validate actual mount/IAM boundaries, image/protocol compatibility and skills
before using the assignment. Never reuse unrelated customer resources.

`npm run synth` retains the manual per-principal `infra/app.ts` path. It writes a
local assembly only. It accepts supported `CDK_DEFAULT_REGION`, a unique
`SILO_STACK_NAME`, immutable image parameters, and optionally `NETWORK_FILE` with
explicit private subnet/route/AZ IDs from `infra/network.example.json`. This
standalone variant seeds skills through a deployment Lambda; the guided variant
uses approved direct seed writes and a shared foundation instead. Avoid mixing
their manifests or lifecycle records.

For a reviewed runtime build, [runtime/README.md](../runtime/README.md) explains
pinned preparation, offline tests and optional local Docker. The guided AWS build
does not depend on local Docker or require changing your development environment.

## Live application variables

| Variable | Required value/purpose |
|---|---|
| MODE | bedrock; default mock makes no AWS calls |
| LIVE_AWS_CALLS | approved, only after live execution authorization |
| PUBLIC_ORIGIN | Exact HTTPS application origin |
| SILOS_FILE | Private JSON map keyed by exact token subject |
| CATALOG_ACL_FILE | Private subject-to-fixture-ID grants; required in live mode |
| STATE_FILE | Durable restricted SQLite path; preserve across restarts |
| OIDC_ISSUER / OIDC_JWKS_URL | Approved HTTPS issuer and signing-key location |
| OIDC_AUDIENCE | Exact protected resource audience, normally origin/mcp |
| OIDC_CLIENT_ID | Existing public SPA client identifier, not a secret |
| OIDC_CONNECT_ORIGINS | Exact HTTPS discovery/token/JWKS origins needed by the SPA |
| AWS_REGION / AWS_PROFILE | Developer provider-chain selection; hosted uses instance role |
| HOST / PORT | Defaults 127.0.0.1:3000; hosted container uses 0.0.0.0 behind loopback-published proxy |
| LOCAL_PROXY_CLIENT_IP | enabled only in the supplied private ALB/nginx topology; header must be overwritten by the trusted local proxy |
| BMA_PUBLIC_SUMMARIES | Optional conservative-preview; disabled by default, live shape review required |

Build with `npm run build` and run `npm start`. Live JWT validation allows RS256/
ES256 only and checks signature, issuer, audience and expiry. Token scopes and
subject grants apply to UI, HTTP, MCP, sources, results and downloads. The hosted
master role assumes only the generated per-subject application roles. Do not use
deployment credentials in the application or put tokens in VITE_* variables.

Configure the existing IdP's root SPA redirect URL, code/S256, exact resource
and scopes. Access tokens remain in browser memory. The app publishes protected
resource metadata/challenges and is not an authorization server. ChatGPT client
registration, consent and redirects are operator/live gates; see [chatgpt.md](chatgpt.md).

## Live acceptance

Prove session creation/input/empty acknowledgements, durable item pagination,
activation/compute replacement, skills propagation, input read-only/output write
mounts, manifest hashes and asynchronous S3 Files synchronization. Repeat actual
JWT/role/NFS/S3 download isolation for two subjects, including a malicious synthetic
document attempting another subject's files. Test lost responses, reconnect,
cancellation and late completion. Evaluate model claims/quotes/numbers against
fixtures. No arbitrary uploads/PDF extraction, retrieval index or general CSV
dialect is promised by this minimal reference.

Before confidential data: review egress destinations, encryption/retention,
logs/alerts, backups and restore. Current SQLite supports one app process; shared
transactional storage, worker leases and distributed limits are needed before
horizontal replicas. Session workspace is execution state, not long-term memory.
