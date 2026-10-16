# Dependency status

The release uses locked official-registry packages. Vitest was updated to 4.1.12
to address test-runner advisories. A clean production-only install (`npm ci
--omit=dev --ignore-scripts`) audited 312 packages with **zero reported
vulnerabilities** at release verification. The AgentCore CLI was absent from that
installation. This point-in-time advisory check is not a security guarantee.

The full development installation audited 1,508 packages and reported **21
vulnerabilities: 2 critical, 12 high, 6 moderate and 1 low**. Every affected node was
inside the pinned `@aws/agentcore@0.31.1` development tool's dependency tree,
including transitive MCP SDK, proxy-addr, handlebars, braces/globbing, source-map,
network parsing and test tooling packages. Semver-compatible `npm audit fix` did
not resolve that tree. Do not treat the deployment toolchain as qualified for
untrusted input or production use.

The CLI is kept at the verified preview version because npm's proposed major
replacement/downgrade can remove required BMA behavior. No forced downgrade,
blanket audit suppression or unverified override was applied. Recheck upstream
CLI releases and rerun validation before deployment. Do not expose CLI dev servers
to untrusted callers. The built application image and generated Python/runtime
images need their own exact-image dependency and binary scans; the npm application
result does not cover them.

Reproduce with a fresh installation and `npm audit --json`. To audit only the
runtime tree, use a separate clean install with `--omit=dev`; the full lockfile's
dev-tree metadata can otherwise affect npm's report. In this lockfile, a separate
`npm audit --omit=dev` still reported 11 nested CLI advisories although none of
those paths existed in the production install; the clean install audit reported
zero. Confirm actual installed paths as well as lockfile reports. Local tests, source publication
and mock UI use do not authorize invoking the cloud tooling.
