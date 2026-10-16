# Workspace instructions

Keep mock and live validation distinct. Do not provision AWS, call models, publish endpoints/plugins, or alter credentials without explicit authorization. Preserve the Databricks reference as read-only. Verify isolation at HTTP, MCP, durable state, S3, and runtime boundaries. Use the documented bedrock-mantle REST contract, never legacy Bedrock Agents APIs or an application-owned model loop.
