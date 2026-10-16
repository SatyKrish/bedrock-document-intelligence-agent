> Historical custom deployment path, retired on 2026-10-14. Use [the official AgentCore CLI path](../docs/agentcore-cli.md). Existing Phase A resources and receipts are preserved; do not replay these commands.

# Managed execution adapter

The application uses AWS's published AgentCore control-plane adapter and the
managed Codex harness. It does not own a model/tool loop. Third-party source and
binaries are ignored and acquired separately under their applicable terms.
Review those terms before building or redistributing an image.

## Pinned preparation

Use Python 3.13+ and the official public AWS/OpenAI archives. The script verifies
archive and extracted-file SHA-256 pins from provenance.json, extracts explicit
members only, verifies the Linux ARM64 ELF header, and rejects symlinked write
destinations. It copies only five allowlisted files into .runtime-build/context.

```sh
python3 scripts/prepare-runtime.py --download
# Or, with previously downloaded verified archives:
python3 scripts/prepare-runtime.py --bundle /path/bma-examples.zip \
  --codex-archive /path/codex-aarch64-unknown-linux-musl.tar.gz
python3 -m unittest discover -s runtime/vendor -p test_control_plane.py -v
python3 -m unittest discover -s runtime -p test_guard.py -v
python3 -m unittest discover -s scripts -p test_runtime_prepare.py -v
python3 scripts/runtime-doctor.py
python3 scripts/build-runtime.py
```

Downloads are public HTTPS GETs without AWS credentials. Preparation/tests/doctor
perform no inference or cloud mutation. build-runtime.py builds only a local
linux/arm64 image with Docker buildx; it never pushes or deploys. Its dedicated
context excludes .env, .state, fixtures, credentials, node_modules and the rest
of the repository. Do not build at the repository root. Docker's official Python
3.13-slim base tag follows the AWS sample but is mutable: review/pin the resolved
base and scan the resulting image before release. CDK requires a reviewed image
digest in a private docintel-* ECR repository in the stack's account/region.

## Guard and runtime wiring

The unchanged official adapter handles activation, generation fencing, turn
leases, child supervision, storage and reconnect. entrypoint.py installs guard.py
before serving. The guard pins supported region/endpoint/service/direct transport,
rejects credential/profile overrides and cross-environment rebinding, disables
manual connect/log actions, bounds HTTP bodies/timeouts, and validates both
restored and every started connection specification. These controls do not
replace IAM, per-principal runtime isolation or production egress restrictions.

The runtime OS process uses UID1000. Input access point maps UID/GID1000 with
ClientMount only; output access point follows the official sample's UID/GID0,
with ClientWrite/ClientRootAccess scoped only to that output filesystem/access
point. Both access points root at /, keeping /mnt/output/<analysisId>/ aligned
with output-bucket <analysisId>/ keys. CDK seeds agent/skills under inputs-bucket
skills/ before runtime creation; the adapter copies /mnt/bma/skills to
/mnt/workspace/skills. Missing skills fail readiness. Existing skill file contents
refresh in offline tests; removed skill directories are not pruned by the sample
adapter, so replace runtime/session workspace when removing capabilities.

## Verified state and remaining gate

On 2026-10-14, pinned Codex 0.154.0 Linux ARM64 and the byte-identical published
AWS adapter were acquired locally; seven upstream, six guarded offline protocol
and two preparation tests pass. Guard tests mock child startup and use local
filesystem mounts. They do not validate Linux execution, SigV4 environment
registration, AgentCore activation, NFS permissions or S3 synchronization.

Docker/buildx are installed; Colima 0.10.3 reports the existing default ARM64
VM stopped (2CPU/4GiB). The configured socket is absent. No Docker Desktop or
OrbStack application was found. Resuming with context/config/SSH updates disabled
was attempted under the existing environment permissions and denied opening
/private/operator-evidence (operation not permitted).
No escalation or alternate launch route was attempted. The smallest user action
is to run `colima start --activate=false --save-config=false --ssh-config=false`
in Terminal, stopping if it asks for new permissions/installation.
The doctor verifies the context and reports that blocker. No daemon was started,
container built, remote exec-server connected, runtime provisioned or model called.
See ../docs/deployment.md for the separately authorized live acceptance steps.

Sources: [AWS preview bundle](https://docs.aws.amazon.com/bedrock/latest/userguide/samples/bma-examples.zip),
[official Codex release](https://github.com/openai/codex/releases/tag/rust-v0.154.0),
[AWS AgentCore preview setup](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-agentcore-runtime.html).
