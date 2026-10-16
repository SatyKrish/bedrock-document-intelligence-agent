# Security boundaries

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SatyKrish/bedrock-document-intelligence-agent/security/advisories/new).
If that route is unavailable, open a non-sensitive issue requesting a private
contact route. Do not include exploit details, credentials or customer documents
in public issues. This experimental reference has no response-time guarantee.

Untrusted input includes user questions, reports, CSV cells, tool results and
provider output. Source text never grants authority. Live JWT signature, issuer,
resource audience, expiration and scopes determine identity; caller-supplied owner,
provider IDs and arbitrary file paths are rejected or absent from tool schemas.
Each owned analysis maps to one provider session. Source access uses catalog ACLs.
UI and MCP share the same service and data boundary. Summaries use the same owner
checks and only explicitly public fields are projected/persisted.

Runtime isolation is a separate boundary: each principal has exclusive buckets,
S3 Files access points, Runtime and application/session roles. Cross-field reuse
is rejected. The Runtime can read selected staged data in its own silo and write
its own outputs. Instruction-only path prefixes are not a tenant security control.
Default mock identities are public fixture tokens and are disabled in live mode.

Downloads require app-owned fixed artifact names, completed status, prior HEAD/GET
availability and source/schema checks, and matching persisted content seals.
CSV quoting, control characters and formula cells fail closed in this narrow
contract. Source quotes and CSV values are checked against the selected fixtures;
full narrative correctness still requires model evaluation and human review.

No AWS provisioning, live model calls, public publishing, credential changes or
OAuth grants are authorized by a local build. See deployment/readiness docs for
identity, egress, storage lifecycle, backups and live IAM validation gates.
