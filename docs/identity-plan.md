# Isolated reference identity plan

Planning decision, 2026-10-14: recommend a new isolated test identity setup for this
reference implementation. Keep the application provider-neutral; use a dedicated
Cognito user pool as the AWS-native example only after compatibility validation.
The discovered existing pool has no OAuth clients, custom scopes or login domain;
its existence alone is not a usable login integration. Do not alter shared pools.
This document authorizes no identity resources, clients, grants, user accounts,
credentials, hosted endpoints or external connections.

Use separate OAuth clients for the browser and ChatGPT. The browser client is
public, has no secret, and uses authorization code plus S256 PKCE. The ChatGPT
client is predefined for the initial test rather than relying on unverified DCR
or CIMD support. Select its authentication method from the provider metadata and
current ChatGPT connection UI; never place a client secret in browser code or a
plugin package. Copy exact redirect URIs from the deployed browser and ChatGPT
management page. Scope synthetic test users Alice and Bob to their own service
sessions, document grants, runtime and file access points. A stable issuer/subject
identifies the same user across both clients; a client ID is not a user identity.

## Compatibility gates before provisioning or connection

- Review the actual issuer's discovery document: exact issuer, HTTPS authorization,
  token and JWKS endpoints, advertised S256, token endpoint authentication methods
  and scopes. Cognito support must be demonstrated against ChatGPT's metadata
  requirements; do not add a metadata proxy or advertise unsupported fields merely
  to make discovery pass.
- Send the exact API resource URI through OAuth and verify the access-token `aud`
  matches it. Cognito documents resource binding through the authorization request's
  `resource` parameter. An ID token or an access token with only `client_id` is not
  a substitute for the API audience check.
- Resolve scope naming before claiming Cognito compatibility. The current app,
  frontend, MCP annotations and metadata use `documents:read` and `analysis:write`.
  Cognito custom scopes have a resource-server prefix and slash. A reviewed,
  configurable external-to-domain scope mapping across these surfaces is still
  required; no permissive suffix matching or acceptance of both formats by default.
- Retain the exact issuer/audience/signature/expiry validation. Test expired and
  wrong-audience tokens, read-only denial of start/cancel, and cross-user session,
  source and artifact denial through both web and MCP.
- Validate consent, refresh/expiry, signout and reconnect with the real browser and
  approved ChatGPT client. Metadata/unit tests alone do not establish compatibility.

The first identity approval packet must list the exact new resources, issuer,
client authentication methods, scopes, callback URLs, test-user process, incremental
identity/hosting costs and retain-data stop procedure. It is separate from the
AgentCore runtime-only $5 reservation. Do not infer provisioning approval from
selection of this planning option.

Sources: [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth),
[AWS Cognito authorization and resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html),
[AWS Cognito resource servers and scopes](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html).
