<p align="center">
  <img src="assets/opedd-logo.png" alt="Opedd" height="72">
</p>

<h1 align="center">opedd-mcp</h1>

<p align="center">
  <strong>Licensed, rights-cleared content for AI agents</strong>: the alternative to unlicensed scraping for RAG, AI search and LLM grounding.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opedd-mcp"><img src="https://img.shields.io/npm/v/opedd-mcp?color=4A26ED&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/opedd-mcp"><img src="https://img.shields.io/npm/dm/opedd-mcp?color=4A26ED&label=downloads" alt="downloads"></a>
  <a href="https://registry.modelcontextprotocol.io/v0/servers?search=opedd"><img src="https://img.shields.io/badge/MCP%20Registry-com.opedd%2Fopedd--mcp-4A26ED" alt="MCP Registry"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/opedd-mcp?color=4A26ED" alt="MIT"></a>
</p>

<p align="center">
  <a href="cursor://anysphere.cursor-deeplink/mcp/install?name=opedd&config=eyJjb21tYW5kIjoibnB4IC15IG9wZWRkLW1jcCJ9"><img src="https://img.shields.io/badge/Add%20to-Cursor-000?logo=cursor" alt="Add to Cursor"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=opedd&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22opedd-mcp%22%5D%7D"><img src="https://img.shields.io/badge/Install%20in-VS%20Code-007ACC?logo=visualstudiocode" alt="Install in VS Code"></a>
  <a href="https://opedd.com/for-ai-agents?utm_source=github&utm_medium=readme&utm_campaign=mcp"><img src="https://img.shields.io/badge/Docs-opedd.com-111" alt="Docs"></a>
</p>

Lets AI assistants (Claude, ChatGPT, Cursor, Windsurf, or any MCP host) find licensed publications, ask them questions, read and verify licensed content, mid-conversation. Every licence is recorded in a public registry on Tempo.

**Unlike generic search APIs**, every answer comes from a publisher who licensed it, with a citation and a record you can show your legal team.

## Quick start

```bash
npx -y opedd-mcp
```

Then add it to your MCP host ([setup below](#claude-desktop-setup)). Discovery tools work with no key. Questions, articles and orders use a buyer key: sign up at [opedd.com/buyer/signup](https://opedd.com/buyer/signup?utm_source=github&utm_medium=readme&utm_campaign=mcp). New accounts get their first 3 answers free.

## Hosted, no install (mcp.opedd.com)

**Claude, ChatGPT and other connector apps:** add the custom connector `https://mcp.opedd.com` and sign in with your work email. No key to copy. Each publication also has its own address, `https://<publication>.mcp.opedd.com`, limited to that publication.

**APIs and agents:** use `https://mcp.opedd.com/mcp` (Streamable HTTP) with your key in an `Authorization: Bearer` header. Without a key it lists the 16 public and buyer tools; the publisher tools appear with a publisher key.

**Claude Messages API:**

```json
{
  "mcp_servers": [{
    "type": "url",
    "url": "https://mcp.opedd.com/mcp",
    "name": "opedd",
    "authorization_token": "opedd_buyer_live_..."
  }]
}
```

**OpenAI Responses API:**

```json
{
  "tools": [{
    "type": "mcp",
    "server_label": "opedd",
    "server_url": "https://mcp.opedd.com/mcp",
    "authorization": "opedd_buyer_live_..."
  }]
}
```

**Cursor** (`.cursor/mcp.json`):

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

Key routing: `opedd_buyer_*` covers questions, articles, the feed and audit tools · `ent_*` an order's feed · a buyer-portal session token covers orders and the account · `opedd_sk_*` (older `opedd_pub_*`) the publisher tools. Your key is forwarded per request and never stored.

## Tools

19 tools. Run locally, all 19 are listed; a tool that needs a key you have not set says which key and where to get it. Every tool carries a `title` and MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

**No key needed**

| Tool | What it does |
|------|-------------|
| `search_content` | Free search across everything licensable: matching articles with publication, price, word count and a short description. No article text |
| `lookup_content` | Look up an article by URL: how it is licensed, or that it is not on Opedd yet |
| `publisher_directory` | Browse publications on Opedd, with article counts, prices and samples, plus publications available on request |
| `request_publication` | Ask for a publication Opedd does not carry yet (url and email) |
| `verify_license` | Check a licence key (`OP-XXXX-XXXX-XXXX-XXXX`): validity, coverage and public-record proof |
| `browse_registry` | Browse issued licences in the public registry |
| `rsl_get` | A publisher's RSL licensing manifest; `jsonld: true` returns its signed CDSM Article 4(3) opt-out receipt |
| `detect_platform` | Detect the platform behind a publication URL and suggest how to onboard it |

**Buyer key (`OPEDD_BUYER_TOKEN`)**

| Tool | What it does |
|------|-------------|
| `search_passages` | Ask a question, get licensed passages that answer it, with citations. Charged per article the answer uses at that publication's price, or included in a monthly subscription. Passages are capped at 300 words or 25% of an article; the same question within 24 hours is free. Filters: `publishers`, `published_after`, `published_before`, `max_results` (1 to 10, default 5), `max_charge_cents`. Needs the `search` scope |
| `get_content` | Read a full article under a monthly subscription (20 articles per person and 200 per order a day; over that, 429 `DAILY_READING_LIMIT`). Pay per answer is search only (403 `SEARCH_ONLY_LICENCE`) |
| `list_feed` | The articles an order covers, with `since` for new ones. Full download + training orders include the text; subscriptions list the catalogue and read through `get_content` |
| `stream_feed_ndjson` | The same feed in bulk, up to 1,000 articles per call (NDJSON) |

The feed tools also accept an order's access key (`OPEDD_ACCESS_KEY`, `ent_*`).

**Buyer account (`OPEDD_BUYER_JWT`, from the buyer portal)**

| Tool | What it does |
|------|-------------|
| `place_licence_order` | Order a licence for one or more publications: AI answers (monthly subscription, or pay per answer) or Full download + training (one-off). Returns the order and its invoice link. Needs `terms_accepted: true` |
| `get_buyer_account` | Your buyer profile and masked API keys |
| `list_licence_orders` | Your orders and lines; with `order_id`, each line's Schedule and its fingerprint on Tempo |
| `get_audit_events` | Every licensed use, with public-record proof |
| `get_compliance_dossier` | A procurement-ready record of licensed use in a date range |

The last three also work with an audit-scoped buyer key.

**Publisher key (`OPEDD_PUB_BEARER`)**

| Tool | What it does |
|------|-------------|
| `list_publisher_content` | Your articles, with prices and stats |
| `push_content` | Send articles to Opedd, 1 to 100 per call (`title`, `url`, `html_body` required) |

## Configuration

| Variable | Description |
|----------|-------------|
| `OPEDD_BUYER_TOKEN` | Buyer API key (`opedd_buyer_live_*`; `opedd_buyer_test_*` for sandbox), from [opedd.com/buyer/signup](https://opedd.com/buyer/signup), under Account, API keys. Questions, articles, the feed and (audit scope) the audit tools |
| `OPEDD_ACCESS_KEY` | An order's access key (`ent_*`), for the feed tools |
| `OPEDD_BUYER_JWT` | Buyer-portal session token, for orders, the account and audit tools |
| `OPEDD_PUB_BEARER` | Publisher API key (`opedd_sk_*`; older `opedd_pub_*` keys still work), from the Opedd dashboard, Settings, For developers |
| `OPEDD_API_KEY` | Deprecated legacy publisher key (`op_*`). Use `OPEDD_PUB_BEARER` |
| `OPEDD_API_URL` | Override the API base URL (default: Opedd production) |
| `OPEDD_MCP_TELEMETRY` | Set to `0` to turn off anonymous usage telemetry |

## Anonymous usage telemetry

For each tool call `opedd-mcp` sends only the tool name, its duration, whether it succeeded and the server version, with a random per-process id. Never parameters, responses, emails, keys, content or your IP. Data goes to Opedd's PostHog (EU). To opt out, set `OPEDD_MCP_TELEMETRY=0` or `DO_NOT_TRACK=1`; nothing is then sent.

## Claude Desktop setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opedd": {
      "command": "npx",
      "args": ["-y", "opedd-mcp"],
      "env": { "OPEDD_BUYER_TOKEN": "opedd_buyer_live_..." }
    }
  }
}
```

## Cursor / Windsurf setup

```json
{
  "mcpServers": {
    "opedd": {
      "command": "npx",
      "args": ["-y", "opedd-mcp"],
      "env": { "OPEDD_BUYER_TOKEN": "opedd_buyer_live_..." }
    }
  }
}
```

## Example prompts

> "What do Opedd's publications say about EU chip subsidies? Cite the passages." uses `search_passages`

> "Is this article licensable? https://www.worldpoliticsreview.com/..." uses `lookup_content`

> "Verify licence key OP-XXXX-XXXX-XXXX-XXXX and tell me what it covers." uses `verify_license`

> "Show me geopolitics publications on Opedd with at least 50 articles." uses `publisher_directory`

> "Get Geopolitical Dispatch's RSL manifest and its signed opt-out receipt." uses `rsl_get`

## Paying

- **With an account:** answers are billed to the card on your buyer account ([opedd.com/buyer/billing](https://opedd.com/buyer/billing)), charged every $25.00 of answers and at month end, with a $500.00 monthly limit for new accounts, raised on request. Licence orders are invoiced through Stripe.
- **Without an account:** an agent can pay for one answer on the spot. `POST https://api.opedd.com/agent-answer` with the same body as `search_passages`. The HTTP 402 response states the price, the licence and the terms; pay by card through the [Machine Payments Protocol](https://mpp.dev) (at least 0.50 USD, the rest kept as credit) and retry. Machine-readable: [api.opedd.com/openapi.json](https://api.opedd.com/openapi.json).

## Development

```bash
git clone https://github.com/Opedd/opedd-mcp
cd opedd-mcp
npm install
npm run dev   # runs with tsx (no build step)
npm run build # compiles to dist/
```

## Learn more

- [Opedd for AI agents](https://opedd.com/for-ai-agents?utm_source=github&utm_medium=readme&utm_campaign=mcp)
- [Documentation](https://docs.opedd.com), including the [MCP guide](https://docs.opedd.com/mcp-server)
- [Verify a licence](https://opedd.com/verify?utm_source=github&utm_medium=readme&utm_campaign=mcp)

## License

MIT
