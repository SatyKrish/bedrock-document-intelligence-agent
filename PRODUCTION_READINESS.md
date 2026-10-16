# Production readiness

**Experimental reference. The mock application is verified; live report acceptance
is blocked at managed-environment registration.**

| Area | Status |
| --- | --- |
| Local build, typecheck and mock service/HTTP/MCP/JWT/SSE tests | Verified locally; see VALIDATION.md |
| Rendered desktop/mobile fixture workflow | Verified with local mocks |
| Native image builds and Runtime provisioning | Observed in a bounded test; test resources later removed |
| Registration and live report generation | Blocked by unresolved registry HTTP 500; no successful report |
| Per-principal IAM/NFS isolation | Application checks and limited S3 denial probes; full live boundary proof pending |
| Durable live event/reconnect/cancellation shapes | Offline contract tests; live acceptance pending |
| S3 Files synchronization and verified live downloads | Pending |
| Real-model citation, numeric and semantic quality | Pending; deterministic mock is not a quality evaluation |
| Hosted UI/TLS/PKCE, real issuer tokens and ChatGPT OAuth | Source/setup documentation only; untested |
| Container security and current upstream/image qualification | Requalify exact dependencies/digests before use; no production assurance |
| Egress, retention, budgets, backup/restore and observability | Adopter production requirements |
| Multiple app replicas and distributed worker leases | Unsupported; application is single-process |
| Accessibility/assistive technology and broader devices | Further validation required |

Inputs are catalog-selected synthetic Markdown/CSV files referenced through text
BMA input. Arbitrary uploads, scanned-PDF extraction, production ACL management,
retrieval indexes and complex CSV dialects are outside this first slice.
Optional public reasoning summaries default to disabled and are never citations.

No timeout, cancellation acknowledgment or local budget field is an enforced
billing cap. See [validation status](docs/validation-status.md),
[runbook](docs/runbook.md) and [independent review](docs/adversarial-review.md).
