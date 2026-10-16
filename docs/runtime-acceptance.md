# Headless synthetic Runtime acceptance

`deployment/runtime-acceptance.ts` exercises the same application Service and
BedrockProvider used by HTTP and MCP. It lets an authorized operator qualify the
managed Runtime before creating a hosted identity or public endpoint. It is a
local CLI, with no authentication-bypass route. It does not validate hosted JWT,
OAuth, ChatGPT installation, NFS denial or all infrastructure boundaries.

Use only after exact image-digest security qualification and explicit approval
for AWS/model usage. Create a private JSON plan with `version:1`,
`syntheticOnly:true`, `mode:"bedrock"`, `receiptDirectory`, `ledgerFile`, two
`cases` containing distinct synthetic subjects and fixed UUID `requestId`s, and
`silos` mapping those subjects to the normal validated Silo configuration. Each
silo needs its own Runtime ARN, session role ARN (`roleArn`), application role
ARN, input/output buckets, region `us-east-1` and model `openai.gpt-6-luna`.
Never put AWS credentials in the plan.

Both paths must be absolute canonical paths with private owned parent directories.
Resolve macOS `/tmp` to `/private/tmp` first. Keep the ledger outside the receipt
directory. The exact plan bytes, including paths and mode, are SHA256-bound.
The default command only validates the plan:

```sh
npm run test:live:runtime -- --plan /canonical/private/plan.json --approval PLAN_SHA256
# Only within the separately approved live scope:
LIVE_AWS_CALLS=approved npm run test:live:runtime -- \
  --plan /canonical/private/plan.json --approval PLAN_SHA256 \
  --execute --receipts /canonical/private/receipts
```

The first case compares the three synthetic annual-report/KPI fixtures; the
second uses only ACME. Cases run serially. An uncertain or failed first case
prevents the second. The service verifies source-grounded result structure,
CSV source values and available artifact bytes before exports. The receipt records
BMA session IDs and report SHA256 values. Review narrative/citation quality too.
The included mock tests are not evidence of AWS availability or model correctness.

An exclusive process lock, separate ledger and SQLite identity marker prevent
concurrent execution and restarting against missing/replaced state. Reuse the
same plan, receipt location, ledger and request IDs when reconciling. Do not
remove an uncertain lock or manufacture a fresh directory to retry paid work.
The monitor is bounded to twenty minutes; its exit does not prove that managed
compute stopped. Keep the provider IDs and reconcile service/runtime state.

This runner does not stop Runtime compute, delete BMA sessions or remove network
resources. The operator must map authoritative AgentCore Runtime session IDs,
stop only owned work/compute, verify termination and perform the separately
approved cleanup. BMA session IDs are not assumed to be Runtime session IDs.
Keep reports, image digests, logs and uncertain synchronization evidence retained.
