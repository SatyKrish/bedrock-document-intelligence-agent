# Document Intelligence with Amazon Bedrock Managed Agents, powered by OpenAI

Experimental reference for cited document analysis with a self-hosted assistant-ui
React frontend, TypeScript backend and ChatGPT MCP/plugin source. The live adapter
targets the **new Amazon Bedrock Managed Agents public preview powered by OpenAI**:
managed Codex harness, AgentCore exec-server runtime and native S3 Files.

**The local mock works. Live AWS report acceptance is not yet qualified.** The
first bounded live test stopped at managed-environment registration with HTTP 500;
its cause is unresolved. No successful live report or ChatGPT OAuth connection is
claimed. See [validation status](docs/validation-status.md) and
[production readiness](PRODUCTION_READINESS.md).

## Run the local demo

Use Node 24 LTS and npm. The demo makes no AWS or model calls.

```sh
git clone https://github.com/SatyKrish/bedrock-document-intelligence-agent.git
cd bedrock-document-intelligence-agent
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build
npm start
```

Open http://127.0.0.1:3000, choose Alice, select the synthetic reports and compare
revenue and operating margins. Expand cited source evidence and download the
Markdown/CSV outputs when verification completes. Bob has a smaller authorized
catalog. Local demo tokens are fixed, public, non-secret test fixtures.

The deterministic mock compares the supplied fixtures; it does not interpret
arbitrary questions or demonstrate real model quality.

## Architecture

```text
assistant-ui React ─┐
                   ├─ authenticated application services ─ ownership/ACL + SQLite
ChatGPT MCP tools ─┘               │
                                  ├─ S3 input staging + source digests
                                  └─ SigV4 bedrock-mantle sessions /events /items
                                             │
                                     managed Codex harness
                                             │
                                  per-principal AgentCore exec-server
                                             │
                          isolated workspace + exclusive S3 Files mounts
                                             │
                       output sync → HEAD/GET → citation/CSV checks → downloads
```

The application monitors the managed execution; AWS owns the agent loop. Durable
state records ownership, request IDs and results. SSE reconnects reconcile durable
items without replaying uncertain writes. UI and MCP share the same authorization
and artifact-availability rules. Each live principal requires exclusive Runtime,
bucket, role and mount assignments. The preview is text-input only, without
subagents or built-in long-term memory.

## Included

- assistant-ui React interface with source selection, cited results, reconnect,
  progress, cancellation and authorized artifact downloads.
- HTTP and MCP domain services, plus a local stdio plugin bridge and workflow skill.
- Synthetic annual reports/KPI CSV, document-analysis and generate/examine/correct skills.
- Raw SigV4 BMA REST adapter, S3 staging/output verification and bounded event parsing.
- Official AgentCore CLI project, CDK source and explicit retention customizations.
- Mock integration tests, UI tests, deployment/runbooks and independent review notes.

## Validate locally

The optional stock AWS baseline fixture is not redistributed: its source ZIP does
not contain a separate license notice. Review the upstream terms before explicitly
retrieving the pinned member for baseline tests. This uses a public documentation
download, not AWS credentials or inference.

```sh
npm run baseline:prepare -- --download
npm run format:check
npm run typecheck
npm test
npm run build
npm run agentcore -- validate --json
npm run plugin:pack
# With the local app already running and Chrome installed:
npm run test:ui
```

The plugin command creates a local source ZIP. It does not install, upload or
publish a ChatGPT plugin. Hosted OAuth and ChatGPT compatibility remain live gates.

## AWS deployment

Read [prerequisites](docs/aws-prerequisites.md), the
[official CLI walkthrough](docs/agentcore-cli.md),
[baseline guide](docs/aws-baseline.md) and
[live validation gates](docs/aws-validation.md) before any cloud action.
Public configs use placeholders and contain no deployment target. No deploy or
model call runs as part of installation, build or tests. Images, access, identity,
networking and spending must be reviewed for your own account.

Use the minimal stock baseline before document analysis. Registry activation,
mount visibility, event shapes, S3 output sync, model quality and real OAuth still
need successful live acceptance. Local timeout controls are not billing caps.

## Documentation

| Topic | Guide |
| --- | --- |
| Official contracts and preview limitations | [Contracts](docs/contracts.md) |
| Setup and per-principal isolation | [AWS prerequisites](docs/aws-prerequisites.md) |
| Runtime deployment | [AgentCore CLI](docs/agentcore-cli.md) |
| ChatGPT/local plugin setup | [ChatGPT](docs/chatgpt.md) |
| Costs, recovery and cleanup | [Runbook](docs/runbook.md) |
| Evidence and limitations | [Validation status](docs/validation-status.md), [validation](VALIDATION.md) |
| Independent review | [Adversarial review](docs/adversarial-review.md) |
| Production work remaining | [Readiness](PRODUCTION_READINESS.md) |

This is an independent reference, with no claim of AWS or OpenAI endorsement.
The [Databricks reference](https://github.com/SatyKrish/databricks-document-intelligence-agent)
provided read-only packaging inspiration. Its runtime/APIs are not included.
Third-party source and dependency terms are recorded in [NOTICE.md](NOTICE.md).

Original code is licensed under [MIT](LICENSE). Before using deployment tooling,
review [dependency advisories](docs/dependency-status.md).
