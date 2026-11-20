# Installing the Opedd MCP server (guide for AI agents)

Opedd provides licensed, cited passages from expert publications and research firms for AI answers. Discovery and verification tools work without a key. New buyer accounts get their first 3 answers free. An agent without an account can pay for a single answer by card at `POST https://api.opedd.com/agent-answer` (Machine Payments Protocol). This file tells an AI agent how to install and configure the server unattended.

## Option A: hosted (no install, recommended)

- **Connector apps (Claude, ChatGPT):** add `https://mcp.opedd.com` as a custom connector; the user signs in with a work email. No key.
- **APIs and headers-capable clients:** `https://mcp.opedd.com/mcp` (Streamable HTTP), with optional header `Authorization: Bearer <key>`. These tools need no key: search_content, lookup_content, publisher_directory, request_publication, verify_license, browse_registry, rsl_get.

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

## Option B: local (stdio via npm)

Requires Node.js 20 or later.

```json
{
  "mcpServers": {
    "opedd": {
      "command": "npx",
      "args": ["-y", "opedd-mcp"],
      "env": {
        "OPEDD_BUYER_TOKEN": "<optional: opedd_buyer_live_* for questions, articles and the feed>",
        "OPEDD_PUB_BEARER": "<optional: opedd_sk_* for publisher tools>"
      }
    }
  }
}
```

Every variable is optional. Omit any you don't have; a tool that needs one says which and where to get it. Also available: `OPEDD_ACCESS_KEY` (an order's `ent_*` key, for the feed tools) and `OPEDD_BUYER_JWT` (buyer-portal session, for orders and the account).

## Where keys come from

- Buyer keys (`opedd_buyer_*`): sign up at https://opedd.com/buyer/signup, self-serve. Keys are under Account, API keys.
- Publisher keys (`opedd_sk_*`): the Opedd dashboard at https://opedd.com, Settings, For developers.
- No key: discovery and verification tools still work.

## Verify the install

Call `publisher_directory` with `{ "limit": 3 }`. A JSON response with a `publishers` array confirms the connection.
