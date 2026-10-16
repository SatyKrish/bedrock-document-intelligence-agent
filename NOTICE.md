# Source provenance and third-party notices

Original application code, UI, skills, synthetic fixtures and infrastructure
adaptations are licensed under [MIT](LICENSE). The read-only
[Databricks reference](https://github.com/SatyKrish/databricks-document-intelligence-agent)
informed packaging and fixture/evidence conventions.

The generated project under `agentcore-reference/DocIntelReference/` derives from
the official `@aws/agentcore` 0.31.1 CLI, copyright Amazon.com, Inc. or its affiliates,
and remains under Apache-2.0. Its license and upstream notices are preserved in
[the AWS license](third_party/AWS-AGENTCORE-APACHE-2.0.txt) and
[the AWS notice](third_party/AWS-AGENTCORE-NOTICE.txt). Reference-specific changes
include configuration placeholders, scoped CLI settings, documentation and an
explicit CDK retention/build-network policy. The stock lifecycle Python files
remain unchanged; `agentcore-reference/DocIntelReference/PROVENANCE.json` records their hashes.
Original adaptations do not remove upstream rights or notices.

The AWS `hello-bma` sample skill is not redistributed in this repository. An
operator may explicitly retrieve the pinned official bundle after reviewing
upstream terms using `npm run baseline:prepare -- --download`.
[Provenance](deployment/baseline-fixtures/PROVENANCE.json) records its URL and hashes.
AWS documentation supplies preview contracts and retains its applicable terms.

The separate historical runtime adapter and Codex executable are external
operator-prepared dependencies and are not included or relicensed here. Review
their terms before preparing an image. npm dependencies retain their own licenses
and notices. A dependency lockfile is not a grant to redistribute bundled binaries.
