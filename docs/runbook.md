> Canonical deployment uses the [official AgentCore CLI](agentcore-cli.md).
> Retain-data stop preserves logs, images and files. Do not use CLI remove/deploy
> cleanup: its default ECR purge/KMS deletion needs separate approval. Its ECR
> lifecycle also expires images beyond ten; do not cross that threshold under a
> retain-data scope. Older custom
> deployment commands below are historical.

# Operations, costs and cleanup

## Progress and recovery

The app starts in mock mode and binds 127.0.0.1. Requests are limited to 32 KiB;
questions to 4,000 characters, selections to four sources, active jobs to two per
principal and starts to 20/hour. Expensive operations have deadlines and SDK
connection/request timeouts. Errors returned to UI/MCP contain bounded codes,
not credential values, command traces or remote response bodies.

A browser disconnect does not cancel work. Reopen an owned analysis from history
or its saved ID. The backend polls known sessions and reconciles durable results.
The UI persists a pending requestId before sending and reuses it after an ambiguous
response. Definitive validation/authorization failures clear the invalid pending
request. A new backend instance marks interrupted create outcomes with no provider
ID uncertain; known interrupted submissions use read-only reconciliation.

After the five-minute monitor budget, status becomes uncertain with a notice
that managed work may continue. Never blindly resubmit or delete a record to clear
uncertainty. Inspect the app-owned provider session through an approved operator
workflow; preserve mappings for cleanup. One analysis is one managed session/turn.

Cancellation is a request; prior effects are not undone. The local mock confirms
it on its next durable poll. Live terminal event schema and late-result timing
must be verified before production. A final valid result that beat cancellation
can remain completed. Outputs remain unavailable until exact names have bytes,
source quotes match selected documents, synthetic CSV rows match report values,
and SHA-256 seals are persisted. Downloads recheck the seal; a changed/missing
object fails closed. This does not certify the semantics of every narrative claim.

## Costs

Mock mode uses no AWS/model resources. A live run meters model tokens, actual
runtime CPU/memory, S3/S3 Files storage and requests, logs, ECR and data transfer.
The standalone stack creates one NAT/EIP per silo; the guided deployment shares
one NAT across silos. Explicit network reuse avoids
creating another NAT; existing fixed charges continue and incremental NAT/data
charges remain. Eight-hour lifecycle settings are limits, not a fixed eight-hour
compute bill. The app's five-minute monitor limit is not a cloud spending cap.

Illustrative USD arithmetic, checked against official pages on 2026-10-14:

| Component and explicit assumption | Estimate |
|---|---|
| Luna Standard In-Region, <=272K context: 50K billed input + 10K output, $0.22/$1.32 per million | $0.0242 model only |
| Runtime v1: 1 consumed vCPU + 2GB continuously for 10 minutes, $0.0895/$0.00945 per hour | $0.0181 runtime only |
| Runtime v2 consumption with same hypothetical usage, $0.1276/$0.0169 per hour | $0.0269 runtime only |
| New NAT + one public IPv4, Ohio example $0.045 + $0.005 per hour | $0.05/hour, $36.50 at 730 hours per new NAT |

These are assumptions, not observed usage or a quote for the inventory's Virginia
resources. Multiple managed calls/retries increase billed tokens; runtime actual
metering/version and target-region prices must be confirmed. Model fee is already
included in the card's In-Region prices. S3 Files/S3/ECR/logs/transfer are excluded
above. NAT processes data even when reusing networking; cross-AZ transfer can add
charges. Session storage is currently uncharged during its public preview, but
that does not cover S3 Files or backing objects. Measure a single synthetic run
before setting an approved rollout budget.

Sources: [Luna model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html),
[AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/),
[VPC pricing](https://aws.amazon.com/vpc/pricing/),
[S3 pricing](https://aws.amazon.com/s3/pricing/). Recheck before deployment.

The guided hosted path also meters private EC2 t4g.small, encrypted EBS (8GiB root
plus 8GiB retained state), ALB hours/LCUs, public ALB IPv4 addresses, DNS, SSM,
CodeBuild and ECR. The official us-east-1 [ALB pricing example](https://aws.amazon.com/elasticloadbalancing/pricing/)
uses $0.0225/hour plus $0.008/LCU-hour: fixed ALB alone is $16.425 at 730 hours,
excluding IPv4/traffic. New NAT and ALB alone can therefore outweigh a small
model run. Obtain current regional EC2/EBS/ARM CodeBuild rates through the
[AWS calculator](https://calculator.aws/) before approval; no exact ARM build
rate or full hosted estimate has been verified here. CodeBuild charges rounded
build minutes plus storage/log services ([pricing](https://aws.amazon.com/codebuild/pricing/)).
The config allowance is planning metadata, not a hard spending cap or quote.
Cleanup preserves billable storage/images/logs by default.

## Cleanup after separate authorization

1. Download and independently retain needed outputs first. Inventory app-owned
   analysis IDs and provider mappings, including uncertain creates.
2. Confirm cancellation/completion before cleanup. Delete only app-owned BMA
   sessions with documented DELETE /openai/v1/agents/sessions/<id> via approved
   SigV4 operator tooling. A session delete does not delete the Runtime definition,
   customer-owned S3 objects or CloudFormation resources.
3. Remove approved runtime/stack resources using deployment tooling after reviewing
   the change set. Stop active Runtime sessions first. Review runtime endpoint
   and image lifecycle, NAT gateway, EIPs, mount targets, VPC endpoints, IAM roles,
   logs and retained resources. With NETWORK_FILE reuse, do not delete existing
   VPC/subnets/routes/NAT/endpoints; only this deployment's new groups/mounts.
4. The CDK intentionally retains buckets, S3 Files filesystems and access points.
   Clean up retained mounts/filesystems, all S3 object versions/delete markers,
   images and logs deliberately after retention approval. Do not assume stack
   deletion removes retained storage, or that normal object deletion removes versions.
5. Revoke only plugin/app links, OAuth clients or grants created for this deployment,
   when specifically authorized. This implementation created none.

For local-only cleanup, stop npm run dev and remove only this repository's ignored
.state, dist, cdk.out and test output after preserving wanted mock evidence. The guided cleanup command does perform approved cloud deletion; follow
[open-source-deployment.md](open-source-deployment.md) and review its sealed
physical-resource snapshot first. No purge command is implemented. Follow the current [AWS cleanup guide](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-cleanup.html).
