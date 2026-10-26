# Installing the Opedd MCP server (guide for AI agents)

Opedd provides licensed, cited passages from independent publications and research firms for AI answers. Discovery and verification tools work without a key; an agent without an account can pay for a single answer by card at `POST https://api.opedd.com/agent-answer` (Machine Payments Protocol). This file tells an AI agent exactly how to install and configure the server unattended.

## Option A — hosted (no install, recommended)

Connect to the hosted Streamable-HTTP endpoint:

- **URL:** `https://mcp.opedd.com/mcp`
- **Auth (optional):** header `Authorization: Bearer <key>` — public discovery tools (lookup_content, publisher_directory, verify_license, browse_registry, rsl_get, detect_platform) work with NO auth.

Example (Cursor / any headers-capable client):

```json
{
  "mcpServers": {
    "opedd": {
      "url": "https://mcp.opedd.com/mcp",
      "headers": { "Authorization": "Bearer ${env:OPEDD_KEY}" }
    }
  }
}
```

## Option B — local (stdio via npm)

Requires Node.js >= 20.

```json
{
  "mcpServers": {
    "opedd": {
      "command": "npx",
      "args": ["-y", "opedd-mcp"],
      "env": {
        "OPEDD_BUYER_TOKEN": "<optional: opedd_buyer_live_* for content retrieval>",
        "OPEDD_PUB_BEARER": "<optional: opedd_pub_* for publisher content push>"
      }
    }
  }
}
```

All env vars are OPTIONAL — omit any you don't have; the matching tools simply require them at call time with a clear error.

## Where keys come from

- Buyer keys (`opedd_buyer_*`): sign up at https://opedd.com/buyer — self-serve, no approval step.
- Publisher keys (`opedd_pub_*`): publisher onboarding at https://opedd.com — self-serve.
- No key at all: discovery + verification tools still work.

## Verify the install

Call the `publisher_directory` tool with `{ "limit": 3 }` — a successful JSON response with a `publishers` array confirms end-to-end connectivity.
