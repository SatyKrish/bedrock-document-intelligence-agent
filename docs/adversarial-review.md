# Independent adversarial review

## Official CLI migration review — 2026-10-14

The subsequent documentation-only review checked all 14 generic policy examples
and the prerequisite/acceptance guides without external calls or execution. It
identified and the primary corrected native CLI credential selection before the
first deployment, missing S3 Files validation reads, and the Lambda handler log
classification/731-day retention. A final static check confirmed the credential
snippet matches native CLI source and prints only caller metadata. Scoped metadata
resource authorization and all actual AWS behavior remain live gates.

A fresh independent read-only reviewer compared the CLI project, application paths,
plugins, lifecycle hashes and generated CDK sources with official 0.31.1 package
assets. Both lifecycle files and all three generated CDK TypeScript files match.
No application workspace or plugin-discovery defect was found. The primary
separately passed 64 tests across 14 files, typecheck, formatting, production build,
plugin packaging, CLI validation and a refreshed native deployment dry run.

The review identified stock CLI defaults that remain deployment constraints:
ECR empty-on-delete and KMS destructive removal/replacement; automatic expiry of
images beyond ten even with a retained stack; and no image-scan review barrier
between CodeBuild and Runtime creation. Imported immutable runtime roles need
explicit ECR/KMS/S3 Files policies and real cross-owner denial evidence. Bare CLI
commands can omit the project-scoped Transaction Search opt-out. The canonical
guide now records these gates and the root npm entrypoint. No generated CDK or
lifecycle code was altered to evade them. Earlier image findings remain unwaived.

The primary also excluded generated runtime projects, nested dependency trees,
CLI state and environment files from the standalone application Docker context.
The newly generated project is not part of the web/API image. This exclusion was
inspected locally; no new container build or scan has run.

Previous review evidence below concerns the earlier local and custom deployment
implementation; it does not qualify the canonical CLI deployment.

An independent reviewer read the implementation and ran isolated in-memory
reproductions, HTTP/MCP isolation checks and TypeScript checks without edits,
AWS calls or credentials. The primary implementation added regression coverage
and ran the full suite in the authorized destination.

| Finding | Change and evidence |
|---|---|
| Cross-principal input/output bucket overlap | Global uniqueness across all input/output assignments |
| Cross-field application/session role reuse | Global uniqueness across both role fields plus runtime uniqueness/account-region checks |
| HTTP issuer/JWKS accepted in live config | HTTPS-only canonical identity/resource configuration validation |
| Quoted spreadsheet formula bypass | Narrow plain-cell CSV contract rejects quotes/control chars/formulas |
| Arbitrary unsupported KPI values called verified | CSV rows match selected report source values and IDs; narrative claims explicitly need semantic evaluation |
| Write-only cancellation returned private progress | Cancellation requires read and write scopes |
| Lost UI response could create a fresh paid request | Persist pending UUID/payload before POST; reuse on retry/reconcile |
| Known interrupted submission never reconciled | Read-only reconciliation for known provider session; never replay input |
| Historical repaired command exit treated terminal | Managed state plus final result determine completion; correction history can contain failure |
| Delayed responses could reappear after identity switch | Identity epoch checks before and after body consumption; clear local state on signout |
| Definitive invalid requests left stuck pending | Clear pending for known pre-commit 4xx failures |
| Stalled staging permanently held busy state | Bounded app operations plus SDK connection/request timeouts |

Reviewer retested those issues as fixed and reported no remaining concrete high
or medium blocker in the local mock slice. Independent Vitest execution was
blocked before tests by EPERM creating a .vite-temp file under the requested
repository; no bypass or escalation was attempted. The primary's full test output
is the suite evidence, distinct from the reviewer's in-memory/typecheck results.

Live IAM enforcement, actual runtime activation/mounts/reconnect/S3 sync, model
quality, egress controls and OAuth/ChatGPT-host compatibility remain gates.
Optional public-summary handling received a separate follow-up review and passed
after fixing oversized IDs, tuple-key collisions and disabled historical-summary
exposure; the UI uses the same turn/item tuple key. Latest evidence is recorded
in VALIDATION.md. This is an independent implementation
review, not a completed formal Codex Security scan or production certification.

## Runtime and infrastructure follow-up

Independent reviewer rechecked official-source/binary/context provenance, mocked
runtime guards and final TypeScript/policy source without Docker, AWS or edits.
Reported source issues were fixed: signed account header, complete restored/default
connection checks and universal start validation, bounded HTTP and disabled manual
connect/log actions, symlinked preparation destinations, output-only root access,
application inputs/* write scope, skill seeding dependency, and same-account/region
immutable ECR URI with exact repository pull policy. Dedicated context and new image
parameters are reflected in runtime/README.md and deployment.md. Final review found
no remaining concrete offline source/wiring blocker. Primary checks separately
passed 37 application and 15 Python tests. Actual BMA Register/ConnectEnvironment
ownership under project/* policy, mount enforcement and compute recovery remain
live gates; offline mocks cannot prove those boundaries.

## Guided deployment follow-up

The independent reviewer examined the cloud builder, hosted application, approval
and cleanup source using read-only TypeScript and isolated in-memory checks.
Primary regression tests cover the same boundaries through mock AWS/HTTP services.
The review found and the implementation fixed:

- Missing cleanup ARNs could match undefined session ownership; complete exclusive
  runtime/role outputs are required before any session listing or mutation.
- Cleanup could delete resources added after approval; material template, parameter,
  output and physical-resource snapshots are rechecked immediately before deletion.
- Cleanup could race new work; hosted admission stops before session enumeration,
  and developer mode requires an explicit assertion that local services stopped.
- Cancellation/build stop acknowledgement was not terminal proof; bounded reads now
  confirm idle/failed sessions and terminal builds before subsequent teardown.
- Reusing stacks with changed grants silently kept old permissions; configuration,
  source, template and parameter fingerprints now reject create-only reuse.
- Any official ARM AMI passed preflight; the supplied boot path now requires AL2023.
- Proxy requests shared a rate bucket; the ALB-appended client address is consumed
  through a private proxy that overwrites the app header, enabled only in that topology.
- Cached ZIP/verifier trust and glob-based inclusion could upload altered code or
  private JSON; fresh exclusive archives and an exact reviewed public file list
  replace the cache/glob. The public config fixture required by packaged tests is included.
- Fixed output paths could follow symlinks; image responses use exclusive UUID paths
  and report writes use checked atomic replacement. ZIP creation uses exclusive mode.
- Foreign documented self-hosted sessions blocked cleanup; clearly unowned roles
  are skipped while owned role/runtime mismatches still halt.
- Status stopped on deleted stacks; recorded IDs/pending operations remain visible.

A final bounded HTTP change briefly rejected null BMA acknowledgements; signedRead
now accepts documented empty/null successful bodies and retains strict report/JSON
limits, with a regression test.

Final targeted independent checks confirmed current typecheck, all 108 explicit inventory/
import closure, drift/ownership detection, AL2023 and preflight freshness/configuration
checks, and session classification, exclusive ZIP mode and empty/oversized HTTP handling.
The reviewer reported no remaining material source blocker in the reviewed
deployment boundaries. No reviewer AWS, Docker, credentials, model calls
or file edits occurred. Incomplete failed silos without confirmed runtime outputs
remain a documented manual recovery gate. Cloud job/boot/mount/OAuth/ChatGPT and
teardown behavior remain unqualified until adopter-authorized live acceptance.

## Independent baseline planner review, 2026-10-15

An independent read-only reviewer examined the check-only baseline planner,
stock fixture, regression cases, exact template diff and cost/network packet.
Two reproducible correctness gaps were fixed: substring command checks accepted
echoed command names, and the session planner did not enforce region/account and
bucket consistency. Evidence now requires exact commands, source and copied-file
hash/path lines, and exact stock head output. The existing silo validator enforces
Runtime/role region/account and exclusive input/output buckets.

Output acceptance now requires recorded pre-turn absence, non-null S3 version,
matching HEAD/GET ETags and versions, matching length and exact expected bytes.
The pure helper cannot authenticate caller-supplied metadata; a future executor
must capture actual S3 absence/HEAD/versioned-GET receipts. No live wire-shape,
mount or synchronization claim is made by these offline tests.

The reviewer independently confirmed the stock skill's bytes, both 23-resource
templates, the Bob-only three-property change and preserved image/build assets.
That planner-only review used earlier alternative cost scenarios, now superseded
by the single held cumulative reservation in the current proposal. Fresh network,
security, cleanup and budget approval remain required; prior endpoint-removal
permission is fulfilled.
No reviewer cloud/model calls or source edits occurred.

## Baseline execution-control review, 2026-10-15

An independent read-only reviewer examined the new local-only controller, used
isolated in-memory failure reproductions and reproduced native template comparison.
No reviewer AWS/model calls, credentials resolution or source edits occurred.
Primary mock regression tests cover the fixes independently.

Reported issues led to strict exclusive action/worker claims, an external
nonce/inode-bound ledger, finite monotonic deadline checks after awaited reads,
atomic watchdog heartbeat replacement, exact account/region/registry/digest and
Runtime role/AP/bucket binding, strict inventory shapes, directory fsync, complete
fixture/helper source sealing, and independent saved-ID Runtime stop even if BMA
cancellation or fresh logs fail. The proposed native patch pins the existing
qualified image digest; all 23 template logical IDs remain and only four Bob
Runtime properties change. Stock CLI lifecycle bytes are unchanged.

A cleanup race additionally required unresolved creation intents to remain pending
and every known physical ID to be checked beyond tag-filter inventory. The reviewer
then reproduced transient exact-ID NotFound/empty reads falsely completing before
any deletion. The fix now requires a successful exact per-operation cleanup
acknowledgment plus subsequent absence (or NAT's positive terminal deleted state).
Both pre-delete NotFound/empty cases have mock regressions. Mutation ACK alone is
also insufficient; later visible resources and AccessDenied remain pending.

The independent final retest passed eight in-memory cleanup cases and TypeScript
checking: missing/wrong-ID acknowledgments, visible resources and AccessDenied stay
pending; exact acknowledgments with absence and terminal NAT deletion are accepted.
The reviewer found no remaining material issue in this delta.

Final local typecheck and full-suite evidence is in VALIDATION.md. This review is
source/mock evidence, not live AWS qualification, spending-cap enforcement or a
formal production security certification. The current proposal remains held.
