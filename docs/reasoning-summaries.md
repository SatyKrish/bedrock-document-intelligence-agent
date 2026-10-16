# Optional public reasoning summaries

Official [BMA sessions documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-sessions.html)
explicitly includes reasoning summaries among durable items and associates output
items with turn_id. The [October 9 Bedrock announcement](https://aws.amazon.com/about-aws/whats-new/2026/10/amazon-bedrock-reasoning-summaries-openai/)
describes Responses API summaries; that is not evidence that BMA accepts its
reasoning.summary request knob. This implementation never sends that knob or
makes a second inference request.

The BMA preview REST page does not document the exact summary item schema.
Consequently capture is **disabled by default**, and optional conservative
compatibility is enabled only with BMA_PUBLIC_SUMMARIES=conservative-preview.
This flag does not assert live wire compatibility.

The explicitly documented implementation assumption is a durable item with
`type: "reasoning"`, opaque id and turn_id, and a `summary` array containing
`{type: "summary_text", text: string}`. Only those public text entries are used.
An assistant durable item must establish the same turn_id. Unknown/untyped/raw
fields, reasoning_text and encrypted_content are never stored or exposed.
Public text is bounded (6,000 characters per part, 24,000 total, 10 summaries),
opaque IDs are nonempty and bounded to 256 characters, summaries are deduplicated by a collision-free turn/item tuple, and projected into a separate app metadata field.
The original provider item body is neither persisted nor logged.

This slice creates one BMA session per analysis; it does not reuse a provider
session across application runs. Summaries inherit the analysis owner check in
HTTP/MCP and the UI displays them under Analysis details, separately from source
citations, CSV verification and findings. They describe the model's public
account of its work, not evidence that claims are correct.

Status is explicit: unavailable_mock, disabled, unavailable or available. Mock
mode never manufactures a summary. Missing/unknown envelopes return unavailable.
Live acceptance must verify actual item schema/turn association with compatible
AWS preview versions before enabling capture, and sample summaries must receive
content/privacy review just like answers. Parser/ownership/hidden-field tests
use clearly synthetic envelopes and do not claim AWS live validation.
