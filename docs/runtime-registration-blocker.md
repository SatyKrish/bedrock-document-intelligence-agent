# Managed environment registration blocker

The approved scoped test reached a real BMA session and AgentCore activation,
then the unchanged Codex exec server repeatedly failed its environment registry
request with HTTP 500 / `internal_server_error`. This localizes the failure to
the registration boundary; it does not establish an AWS defect or justify
broader IAM/network access. Independent read-only review found no source-backed
application defect. The private endpoint registration/connection contract and
provider-side project/principal evaluation remain unresolved.

The lifecycle launched Codex 0.154.0 with the service-supplied Mantle
`/openai/v1` endpoint, expected environment ID, SigV4 service and region. Its
activation HTTP 200 means **connecting**, not registered. Captured first-page
logs contain 38 repeated registry errors from 02:09:48–02:12:52 UTC on October15.
The stock monitor explains retries; the application never resubmitted its input.
The first BMA session-create response was HTTP 201. Exact request and session
identifiers remain in the private operator journal.

The operator stopped the local runner, cancelled the existing session once and
stopped the authoritative AgentCore Runtime session from its logs. BMA reported
idle with zero durable items; cancellation was acknowledged. AgentCore returned
200 and the lifecycle logged SIGTERM. The application remains conservative about
the original input outcome; model usage is unconfirmed. There is no downloadable
report and the second synthetic case never started. Do not create a replacement
session, replay the input or treat the lack of items as zero billed usage.

For provider support, the private journal contains exact BMA session/environment
and Runtime-session IDs, first/last error events and streams, image digests,
Codex/lifecycle provenance, role and endpoint policies, readiness/DNS/SG/routes,
and final cancellation/stop/endpoint-removal receipts. Ask the provider to confirm
`RegisterEnvironment`/`ConnectEnvironment` over Mantle PrivateLink and the project
ARN/principal context evaluated for those requests. Do not publish the private
journal or send a support request without the user's direction.

See [dated results and cleanup](validation-status.md). Any subsequent run must
review its concrete endpoint, credential/identity, cost and invocation scope;
the completed test is not an open-ended retry authorization.
