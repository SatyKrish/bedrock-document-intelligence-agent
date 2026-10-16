# Contributing

Use a supported Node LTS release and npm ci --ignore-scripts from the official
registry. Keep live AWS calls gated and distinguish docs-based contract evidence
from actual service validation. Run typecheck, build, tests, CDK synth and local
mock UI tests for affected paths. Preserve source ownership and durable request
semantics in both HTTP and MCP tools. Update docs/contracts.md when preview wire
assumptions change. New dependencies must come from reputable official registries.
Do not commit .state, tokens, AWS profiles, runtime binaries or customer inputs.

New build inputs must be added deliberately to deployment/source-files.json.
Keep that exact public source inventory free of adopter configuration, credentials,
customer documents, vendor archives and dependency trees. Deployment is create-only;
do not weaken configuration drift checks to add an implicit update path. All cloud
controller tests must use fake AWS/HTTP adapters. Preserve the original-code license and third-party notices. Do not publish private operator data or generated credentials.
