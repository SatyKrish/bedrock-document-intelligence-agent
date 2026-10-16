# Local plugin and ChatGPT setup

`plugin/document-intelligence/` is portable Agent Plugins 1.0 source. Its manifest
has a domain workflow skill, a stdio bridge configuration, and honest tool metadata.
`dist/document-intelligence-plugin.zip` is a private source export. It was not
installed, uploaded or published. No app IDs or nonexistent remote endpoints are
invented in the manifest.

## Local desktop development

Run the main app in mock mode at http://127.0.0.1:3000. The stdio bridge calls that
application's authenticated /mcp endpoint; it does not create a separate service
store, bypass ownership checks, or hold AWS credentials. In the source package's
server directory, install the pinned bridge dependencies from the official npm
registry with lifecycle scripts disabled. The main project dependency tree also
allows the bridge to run during repository development.

Configure DOCINTEL_URL to the verified /mcp URL and provide DOCINTEL_TOKEN through
the host's protected process environment. For local fixture testing only,
`demo-alice` and `demo-bob` are non-secret mock identities. Never package a real
access token or client secret in mcp.json. Install the source/ZIP in a compatible
local plugin host only when explicitly requested. Local stdio is a desktop
integration; it does not make localhost reachable from ChatGPT web/mobile.

The current local package includes instructions as a portable skills directory.
Remote MCP initialization also returns concise server instructions. The draft
MCP skills import extension is not advertised or implemented; remote tool
connection alone does not auto-import the packaged workflow skill.

## Hosted walkthrough

Follow the [current AgentCore CLI guide](agentcore-cli.md) and
[isolated identity plan](identity-plan.md) to plan an adopter-owned
HTTPS application and authenticated /mcp endpoint. Hosting/TLS/DNS source and
readiness checks are implemented and tested offline; no hosted deployment has
run. The recommended reference path is a new isolated test identity setup;
provider/client/grants/certificate/zone and live ChatGPT acceptance remain approval
and validation gates. The CLI does not register clients or grant access.
The source package's local stdio bridge remains an optional desktop developer path.
No remote URL/app identity is returned until the adopter's deployment exists.

## Remote ChatGPT connection after approval

Use the same Streamable HTTP backend at an approved HTTPS /mcp URL. Do not publish
or create a tunnel merely to test. ChatGPT requires reachable authorized hosting
(or a separately approved private connection mechanism), resource metadata and
an OAuth flow supported by its current developer connection UI.

Configure the existing IdP to issue tokens for the exact MCP resource audience,
with documents:read and analysis:write. Publish the authorization server metadata
and S256 support. Choose approved CIMD, DCR or a predefined ChatGPT client; do not
silently create clients or grants. Use the exact redirect URI shown in ChatGPT's
connection management page, and follow current issuer-identification guidance.
The app supplies protected resource metadata and WWW-Authenticate challenges,
but it is not an authorization server. Host-support and consent flows are live
connection gates.

Use MCP Inspector locally to verify /mcp initialization and all tools, then the
approved ChatGPT developer flow after authorization. The SDK tests exercise local
HTTP MCP and the stdio bridge without installing the plugin in ChatGPT.

## Tool sequence

| Tool | Purpose | Scope |
|---|---|---|
| list_documents | Select from authorized synthetic sources | documents:read |
| read_document | Inspect one authorized source | documents:read |
| start_analysis | Create an owned comparison/report job with requestId UUID | documents:read + analysis:write |
| get_analysis | Reconcile progress/result and separately labeled optional public summaries | documents:read |
| list_artifacts | List outputs only after availability/content checks | documents:read |
| get_artifact | Retrieve an owned sealed report as UTF-8 text | documents:read |
| cancel_analysis | Request cancellation and return owned progress | documents:read + analysis:write |

Use the same requestId and identical payload on a transport retry. Start may
consume AWS/model resources in live mode, and is annotated as a write; cancellation
is annotated destructive because prior work may be abandoned. Tool annotations
assist host behavior but do not replace backend authorization. Unknown IDs return
bounded not-found errors; tools never accept arbitrary filesystem/S3 paths.

Official setup references: [MCP server](https://developers.openai.com/plugins/build/mcp-server),
[authentication](https://developers.openai.com/plugins/build/auth),
[connection/testing](https://developers.openai.com/plugins/deploy/connect-chatgpt).
