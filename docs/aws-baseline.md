# AWS baseline before document analysis

Use a separate reviewed operator plan and your own exact resource identities.
The public reference has no AWS target or run approval. See
[validation status](validation-status.md) for the unresolved live gate.

## Official CLI and sample compatibility

The existing Runtime stays in the official `@aws/agentcore@0.31.1` native stack.
Do not deploy the separate sample stack or edit stock lifecycle Python. The CLI
uses CodeBuild, while the CDK sample builds locally. Reuse the qualified existing
image; requalification is required if image inputs change.

| Concern | CLI-compatible baseline |
| --- | --- |
| NAT networking | Separate explicit AWS CLI prerequisites; native NetworkConfig has no NAT flag |
| Lifecycle | Proposed Bob idle/max compute lifetime both 28,800 seconds, as in the guide |
| Workspace | Proposed session storage, home, state and Codex home at `/mnt/workspace` |
| Skills | First turn copies verified stock bytes explicitly; CLI lifecycle lacks sample adapter automatic copy |
| Storage | Reuse exclusive Bob mounts `/mnt/bma` and `/mnt/output` |
| Model | `openai.gpt-5.6-luna` for this baseline; product configuration uses GPT-6 Luna |
| Image identity | Explicit proposed CDK ContainerUri digest binding; no invented CLI schema field |
| Cleanup | Preserve data, transcripts, image, key, logs and updated Runtime configuration |

Retrieve the pinned stock fixture with `npm run baseline:prepare -- --download` after reviewing upstream terms. The retrieved bytes remain unchanged; [provenance](../deployment/baseline-fixtures/PROVENANCE.json)
and [NOTICE](../NOTICE.md) record source/redistribution caveats. The product service
still requests `/mnt/home/workspace`. Do not point it or the report acceptance
runner at the baseline profile before deliberate workspace/model alignment.
Runtime version changes can reset session storage; verify Bob remains unused
**before** the separate native update, and halt if preservation is uncertain.

## Local planning, execution source and evidence

`deployment/aws-baseline.ts` remains a check-only planner. For an adopter, prepare
a private single-owner silo JSON with the exact Runtime/roles/buckets and the
baseline model in us-east-1, then run:

```sh
npm run baseline:plan -- \
  --project /private/DocIntelReference/agentcore/agentcore.json \
  --silo /private/bob-baseline-silo.json --runtime Bob \
  --out /private/new-baseline-proposal
```

Never deploy public placeholders; the public project has no targets.
`deployment/baseline-control.ts` and `deployment/baseline-live.ts` now provide a
separate, locally mock-tested evidence collector and deadline/cleanup controller.
They use the official AWS CLI for resource operations, SigV4 BMA REST and S3 SDK
for service evidence, not another agent loop or a replacement deployment CLI.
They are **unqualified against live AWS**. Check mode verifies the exact private
plan, official binary and source hashes without credentials, AWS calls or arming.
The execute/watchdog modes require separately authorized live scope; no npm live
entrypoint or automatic follow-on run is enabled.

The immutable journal, external run ledger, single worker claim and detached
watchdog enforce no write replay. Durable items reconcile SSE disconnects using
`/events?stream=true`; no undocumented turn/resume endpoint is assumed. Every input
is gated again after awaited reads and before POST. Ambiguous writes stop new work.
One session/two serial turns, an exact stock skill/hash check and fresh versioned
S3 output acceptance make up the whole baseline. Unknown preview wire shapes fail
closed. Review the controller source for timers, cleanup evidence and error-capture limits.

Use an isolated private project copy for native schema validation, CDK compilation
and local synthesis with the same generated context as the deployed template.
Bare Node synthesis without that context omits log groups and changes policies.
The explicit digest-binding patch is proposed source, not applied to either
canonical project. [Patch](examples/network/baseline-image-digest.proposed.patch)
and [example binding](examples/network/baseline-image-binding.example.json) are
review inputs. AWS documents digest-compatible ContainerUri in the
[AgentCore API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ContainerConfiguration.html)
and [CloudFormation property](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-runtime-containerconfiguration.html).

Context-correct proof preserves all **23** logical IDs and every template field
except Bob Runtime's artifact, environment, filesystem and lifecycle properties.
Build triggers/source assets/ECR/KMS/roles/Alice/network are unchanged. No new
build/image/key/role or resource replacement is proposed. Previous template SHA256:
`41556d7f9d4ddab4724dde968159f6dfd242c73cc78bdc9655fb43c5cc8f4c2b`.
Proposed digest-bound template SHA256:
`8073c6228a7b6c5ae81acc0e4204004d7ab56ab71755bceb375b967ea059cff5`.
This is synthesis evidence, not proof that the proposed Runtime version works.

## Cost and remaining live gates

The [illustrative cost JSON](examples/network/nat-baseline-cost.proposed.json)
shows how to reserve runtime compute, NAT, IPv4, model usage, logging and cleanup
contingency. Its $15 total is an example, not approval, a quote or a hard billing
cap. Replace every allowance with current regional pricing and your own approved
budget before running anything. Eight hours is per compute lifetime and cannot
bound a replacement or overall session. Failed hosts, credentials, control-plane
operations, cancellation or cleanup can exceed any reservation.

Check current [VPC](https://aws.amazon.com/vpc/pricing/),
[AgentCore](https://aws.amazon.com/bedrock/agentcore/pricing/) and
[Bedrock](https://aws.amazon.com/bedrock/pricing/) pricing, including the chosen
model, data transfer and retained resources. No invoice was reconciled for the
local reference, and the example does not authorize an automatic budget increase.

Fresh approval, caller/storage preservation checks, native update, exact Runtime
readback, image qualification freshness and actual registration/turn/mount/S3 sync
remain live gates. Every real run requires its operator to approve its own scope and cost.
