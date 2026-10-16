# Validation status

This is an experimental local reference, not a qualified production deployment.

The local application and synthetic HTTP/MCP/JWT/SSE/isolation behavior have been
verified with mocks. Desktop/mobile rendered checks exercised the local workflow.
The release verification commands and exact counts are recorded in VALIDATION.md.

A bounded AWS test successfully built two ARM64 images and created two AgentCore
Runtimes using the official CLI. The first BMA session then failed during managed
environment registration with HTTP 500. The operator cancelled/stopped that work,
never replayed the uncertain input, and never started the second analysis. No
live report, live quality, mounted-file or output synchronization pass is claimed.
The underlying registration cause is unresolved; a networking change is not a
proven fix. See [registration troubleshooting](runtime-registration-blocker.md).

The account-specific test resources were subsequently torn down. AWS-owned network
interface release and KMS deletion waits were recorded privately. Cleanup is a
separate operation and is not evidence of live report success. Private receipts,
resource IDs, operator approval packets, local paths and credentials are excluded
from this public repository. Their historical identities must never be copied
into an adopter deployment.

The source still requires live qualification of registration, exact API wire
shapes, per-principal mounts, durable reconnect/cancellation, S3 Files output sync,
source/numeric model quality, hosted JWT/PKCE and ChatGPT OAuth. Unknown shapes fail
closed. No public endpoint, credentials, OAuth client or plugin upload is included.

The canonical public deployment remains the pinned official AgentCore CLI with
unchanged lifecycle code. Older custom deployment helpers are retained as source
history; they do not replace the native CLI or establish a successful deployment.
The explicit proposed image-digest patch is not applied by default. A separate
operator-reviewed profile and image qualification are required for real use.

One session and two serial text inputs form the optional hello-bma/output baseline.
Eight hours is a per-compute lifetime, not a session-wide or monetary cap. A local
watchdog requires an awake host, valid credentials and AWS reachability; it cannot
promise a maximum bill. No personal prior budget or retained deployment is a
public authorization to run tests in another account.
