# Local verification

Release verification used a clean source snapshot and locked official-registry
npm dependencies on 2026-10-16, without AWS or model calls:

- `npm ci --ignore-scripts --registry=https://registry.npmjs.org`: passed.
- `npm run format:check`: passed.
- `npm run typecheck`: passed.
- `npm test`: **99 tests passed in 17 files**, using Vitest 4.1.12.
- `npm run build`: passed.
- `npm run agentcore -- validate --json`: `{"success":true}`.
- `npm run plugin:pack`: local source ZIP created; no installation or upload.
- Pinned baseline fixture preparation: upstream ZIP/member hashes matched.
- Production-only install: 312 packages audited, zero reported advisories;
  full development tree: 21 advisories confined to the pinned CLI. See
  [dependency status](docs/dependency-status.md) for scope and lockfile caveats.

The HTTP/MCP integration tests require local loopback sockets. The restricted
sandbox first denied those two tests; rerunning with local socket access passed.
Earlier rendered desktop/mobile validation passed six Playwright tests against the
same mock UI. No frontend behavior changed for source publication.

The available local Node runtime was 25.8.2; Node 24 LTS is the documented target.
Vite's approximately 591 KiB main bundle advisory and historical sample CDK AMI/AZ
warnings are known. No production deployment or model-quality claim follows from
these checks. See [validation status](docs/validation-status.md).

Covered behaviors include cross-principal HTTP/MCP/files/artifacts, issuer and
scope checks, durable request IDs and uncertainty without write replay, bounded
streams/errors, deterministic citations/CSV values, source packaging, mock output
availability, exact image/role/AP bindings, deadline admission, saved-ID compute
stop, foreign-resource preservation and positive cleanup evidence.

The official CLI lifecycle files remain unchanged. Native build/Runtime creation
was observed, but managed registration failed and no live report was produced.
Actual mounts, output synchronization, live ownership, real OAuth and ChatGPT remain
gates. Private account/operator logs and identifiers are not part of the release.
