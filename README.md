<p align="center">
  <img src="assets/opedd-logo.png" alt="Opedd" height="72">
</p>

<h1 align="center">opedd-mcp</h1>

<p align="center">
  <strong>Licensed, rights-cleared content for AI agents</strong> — the alternative to unlicensed scraping for RAG, AI search, and LLM grounding.
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

Lets AI assistants (Claude Desktop, Cursor, Windsurf, or any MCP-compatible host) discover, purchase, and verify content licenses autonomously — mid-conversation, without opening a browser. Every license is recorded in a public registry on Tempo, with cryptographic proof.

**Unlike generic search APIs**, Opedd returns content with a verifiable license key — with the rights cleared and a record you can show your legal team.

## Quick start

```bash
npx opedd-mcp
```

Then add it to your MCP host (see [Claude Desktop / Cursor / Windsurf setup](#claude-desktop-setup) below). Discovery + verification tools work with no configuration; purchasing and content retrieval use optional API keys from [opedd.com](https://opedd.com?utm_source=github&utm_medium=readme&utm_campaign=mcp).

## Hosted endpoint — no install (mcp.opedd.com)

Prefer zero-install? The same 21 tools are served hosted at **`https://mcp.opedd.com/mcp`** (Streamable HTTP). Auth is an `Authorization: Bearer` header with any Opedd key — public discovery tools need no auth at all.

**Claude Messages API** (production agents):

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

**OpenAI Responses API**:

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

**claude.ai / Claude Desktop custom connector** (all plans): Settings → Connectors → *Add custom connector* → URL `https://mcp.opedd.com/mcp`; add a `Authorization: Bearer <your key>` request header for the credentialed tools.

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

Key routing: `opedd_sk_*` (legacy `opedd_pub_*`) → publisher tools · `opedd_buyer_*` → content retrieval · `ent_*` → bulk feeds · buyer-portal JWT → audit/compliance/EU-AI-Act tools. Your key is forwarded per request and never stored by the gateway.

## What it does

Exposes up to 21 tools to any AI assistant (some are conditional on env vars):

Every tool carries a `title` and MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so an assistant can tell which tools only read and which spend money or write (v0.12.0).

**Always available — discovery + per-article purchase + onboarding + rights signaling**

| Tool | Description |
|------|-------------|
| `search_content` | **Free discovery.** Full-text search across everything licensable (v0.8.0) — ranked matches with publisher, prices, word count and a description snippet; quotes for phrases, `-word` to exclude. Returns **no article text** — use `search_passages` to actually read |
| `search_passages` | **Paid per answer, or included in a monthly subscription.** Ask a question, get licensed passages that answer it, with citations. Per-question licences: charged once per publisher per question at that publisher's own price, capped at 300 words or 25% of the article, counted cumulatively. Monthly AI answers subscriptions (v0.12.0): included, not capped, from the subscription's start. Narrow with `publishers`, `published_after`, `published_before`, `max_results` (1–25). Needs a buyer key with the `search` scope. Re-asking within 24h is free |
| `lookup_content` | Look up an article by URL — returns title, publisher, pricing, or that it is not on Opedd yet |
| `request_publication` | Ask to be told when a publication Opedd does not carry yet becomes available (url + email; no key) |
| `purchase_license` | Buy a Human republication licence for one article via Stripe — returns OP-XXXX-XXXX key. Requires `terms_accepted: true` (genuine buyer assent to opedd.com/terms; recorded with the licence) |
| `verify_license` | Verify a license key — returns validity, article, publisher, public-record proof |
| `browse_registry` | Browse the public Opedd registry — lists issued LICENSES (use `publisher_directory` to browse publishers themselves) |
| `publisher_directory` | Browse the public Opedd publisher catalog — paginated publishers with article counts + pricing + sample articles (primary buyer-discovery surface for AI labs) |
| `place_licence_order` | Place a licence order for one or more publishers: AI answers (`monthly` full text, or `metered` pay-per-request snippets ≤300 words / 25%), Full catalogue (`archive`, `one_time`: everything published up to the order date, kept permanently, no AI training), AI training (`one_time`, back catalogue), client display (`monthly` × end clients). Optional `include_archive: true` on a monthly AI answers order adds each publisher's Full catalogue for complete access. Each publisher is its own Schedule at its own price; returns the order, lines, `unavailable` publishers and `hosted_invoice_url`. Needs `OPEDD_BUYER_JWT` and `terms_accepted: true` |
| `rsl_get` | Fetch a publisher's RSL Standard manifest — public discovery surface; `jsonld: true` returns CDSM Article 4(3) signed receipt (Phase 12 W1.1) |
| `detect_platform` | Detect the content platform behind a URL — returns suggested onboarding workflow for Substack / Beehiiv / Ghost / Medium / Brevo / custom (Phase 12 W3.1) |

**Requires `OPEDD_BUYER_TOKEN` (opedd_buyer_live_*) — one key covers search, articles and the feed (v0.12.0)**

| Tool | Description |
|------|-------------|
| `get_content` | Retrieve a licensed article under any order your account holds — full text for AI answers monthly and client display orders; pay-per-request licences read through `search_passages` (403 `SEARCH_ONLY_LICENCE`); includes 7 RAG metadata fields (author, language, word_count, content_hash, image_urls, canonical_url, tags) |

**Feed tools — `OPEDD_BUYER_TOKEN` + `order_id`, or an order's `OPEDD_ACCESS_KEY` (ent_*)**

| Tool | Description |
|------|-------------|
| `list_feed` | List the articles a licence order covers, with `since` delta-feed support. AI training and Full catalogue orders carry full `content_body` (`content_access: "included"`); monthly orders are discovery-only (`content_access: "retrieval_per_article"`, fetch text via `get_content`); per-request orders are `"search_only"`. With a buyer key, pass `order_id` (optional when the account holds one active order) |
| `stream_feed_ndjson` | Bulk-export up to 1000 articles per call via NDJSON wire format. Same content contract and credentials as `list_feed` |

**Requires `OPEDD_BUYER_JWT` (Supabase JWT) — buyer account + audit + compliance + attestation surfaces**

| Tool | Description |
|------|-------------|
| `get_buyer_account` | Fetch buyer profile + masked API key list — buyer-dashboard mental model |
| `list_licence_orders` | The buyer's licence orders and lines; with `order_id`, each line's Schedule document and its SHA-256 (the fingerprint recorded on Tempo). Also works with an audit-scoped `OPEDD_BUYER_TOKEN` |
| `get_audit_events` | Per-event audit ledger with public-record (Tempo) inclusion proofs inline (Phase 9.x + 10 M5) |
| `get_compliance_dossier` | Procurement-defense compliance dossier mapping retrievals to license terms (Phase 11 M4) |
| `article_53_attestation` | Signed compliance attestation (JWT) for a license — the artifact a buyer hands to legal/procurement (Phase 12 W1.4) |

**Requires `OPEDD_PUB_BEARER` (opedd_sk_*; legacy opedd_pub_* still works) — publisher-side**

| Tool | Description |
|------|-------------|
| `list_publisher_content` | List your own articles with pricing and stats |
| `push_content` | Push your articles to Opedd so AI buyers can license them — 1–100 per call (`title`/`url`/`html_body` required, everything else optional). Onboard your back-catalogue or new posts with no code, straight from your AI assistant. |

### Compliance artifacts (publisher-side vs buyer-side — never conflated)

Per Opedd's platform invariants (W1.6 amendment):

- **`rsl_get(publisher_id, jsonld=true)`** → publisher-side **CDSM Article 4(3)** opt-out declaration (signed JSON-LD receipt over the reservation state).
- **`article_53_attestation(license_id)`** → buyer-side **signed compliance attestation** (HS256 JWT scoped to one license).
- **`get_compliance_dossier(from, to)`** → comprehensive procurement-defense dossier covering BOTH sides (publisher CDSM reservation honored + buyer attestation evidence chain).

These serve different audit-defensibility modes and never share wire format. Tool descriptions cite the W1.6 invariant inline.

## Install

```bash
npm install -g opedd-mcp
```

Or run directly with npx:

```bash
npx opedd-mcp
```

## Configuration

Set environment variables to pre-configure the server:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPEDD_BUYER_EMAIL` | Recommended | Your email — used as default for all purchases |
| `OPEDD_PAYMENT_METHOD_ID` | Recommended | Stripe `pm_...` ID — used for autonomous per-article purchasing |
| `OPEDD_BUYER_TOKEN` | Optional | Buyer API key (`opedd_buyer_live_*`; `opedd_buyer_test_*` for sandbox) — enables `search_passages` (with the `search` scope), `get_content`, `list_feed` + `stream_feed_ndjson` (with `order_id`) |
| `OPEDD_ACCESS_KEY` | Optional | An order's enterprise access key (`ent_*`) — alternative credential for `list_feed` + `stream_feed_ndjson` |
| `OPEDD_BUYER_JWT` | Optional | Supabase session JWT from the buyer portal — enables `place_licence_order` + `list_licence_orders` + `get_buyer_account` + `get_audit_events` + `get_compliance_dossier` + `article_53_attestation` |
| `OPEDD_PUB_BEARER` | Optional | Publisher API key (`opedd_sk_<32-hex>`, canonical since 2026-08-27; older `opedd_pub_<32-hex>` keys keep working) — from the Opedd dashboard, Settings → Developers. Enables `list_publisher_content` (+ `include_body`) and `push_content`. |
| `OPEDD_API_KEY` | Deprecated | Legacy Publisher API key (`op_...`) — fallback during the transition window; will stop working when opedd-backend Phase C deploys. Migrate to `OPEDD_PUB_BEARER`. |
| `OPEDD_API_URL` | Optional | Override the API base URL (default: Opedd production) |
| `OPEDD_MCP_TELEMETRY` | Optional | Set to `0` to disable anonymous usage telemetry (see below) |

> **Getting a Stripe payment method ID**: Save a card in your Stripe account and retrieve the `pm_...` ID via the [Stripe API](https://stripe.com/docs/api/payment_methods).

## Anonymous usage telemetry

To understand how AI assistants use this server, `opedd-mcp` sends anonymous
telemetry for each tool call: **only the tool name, its duration, whether it
succeeded, and the server version** — plus a random per-process id. It never
sends tool parameters, responses, your email, API keys, tokens, content, or
your IP. Data goes to Opedd's PostHog (EU region).

**To opt out**, set either environment variable before starting the server:

```
OPEDD_MCP_TELEMETRY=0
# or the cross-tool standard:
DO_NOT_TRACK=1
```

When opted out, no telemetry client is created and nothing is sent.

## Claude Desktop setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opedd": {
      "command": "npx",
      "args": ["opedd-mcp"],
      "env": {
        "OPEDD_BUYER_EMAIL": "you@yourcompany.com",
        "OPEDD_PAYMENT_METHOD_ID": "pm_..."
      }
    }
  }
}
```

## Cursor / Windsurf setup

Add to your MCP settings:

```json
{
  "opedd": {
    "command": "npx opedd-mcp",
    "env": {
      "OPEDD_BUYER_EMAIL": "you@yourcompany.com",
      "OPEDD_PAYMENT_METHOD_ID": "pm_..."
    }
  }
}
```

## Example usage

Once configured, you can ask your AI assistant:

> "Look up the licensing options for this article: https://theinformation.com/articles/..."

> "Purchase a human republication license for that article on my behalf."

> "Verify license key OP-XXXX-XXXX and tell me what it covers."

> "Browse the latest licenses from The Information publisher."

### Phase 12 Wave 1 + 3 surfaces (v0.3.0)

> "What does publisher 8268c353-ffa3-4db3-bbb2-90ddbbb43e41 license? Pull the RSL manifest." — uses `rsl_get`

> "Get me a CDSM Article 4(3) signed receipt for that publisher's reservation state — set `jsonld: true`." — uses `rsl_get` with content negotiation

> "Generate a signed compliance attestation for our license `11111111-...` covering the last 90 days. I need the artifact for our procurement audit committee." — uses `article_53_attestation` (requires `OPEDD_BUYER_JWT`)

> "This publisher just signed up: `https://noahpinion.substack.com`. Which onboarding workflow should we use?" — uses `detect_platform`

> "Browse the finance category in the Opedd catalog — show me publishers with at least 50 articles." — uses `publisher_directory`

> "What's in my buyer account? Show me my active API keys." — uses `get_buyer_account` (requires `OPEDD_BUYER_JWT`)

The assistant will call the appropriate Opedd tools, show you the results, and—if you've pre-configured a payment method—can complete a purchase autonomously.

## Payment methods

Purchases use **Stripe** by default (via `pm_...` payment method IDs). USDC on Tempo is also supported by the Opedd API — pass `payment: { method: 'usdc', tx_hash: '0x...' }` directly to `agent-purchase` if building a custom integration.

## Development

```bash
git clone https://github.com/Opedd/opedd-mcp
cd opedd-mcp
npm install
npm run dev   # runs with tsx (no build step)
npm run build # compiles to dist/
```

## How Opedd compares to search APIs

| | Opedd | Generic search APIs |
|---|---|---|
| **What you get** | Licensed content + license key + public-record proof — all in one API call | Scraped web content, no rights |
| **Content delivery** | Full article text via API (JSON) — bulk on flat-fee licenses, per-call (metered) on filtered licenses; real-time feed via webhooks | Scraped snippets or full-page dumps |
| **Content quality** | Curated publisher content (niche B2B newsletters, expert analysis) | Whatever's on the open web |
| **Rights** | Verifiable license key per article, publisher-authorized | No rights clearance |
| **Proof** | Public record (Tempo) — independently verifiable | None |
| **Compliance** | Signed attestation + full provenance chain | No provenance |
| **Pricing** | Publisher sets their own price per article | Platform decides |
| **Delivery modes** | Per-article API, bulk feed (JSON firehose), buyer webhooks (push) | Query-response only |
| **Protocol** | REST + MCP native | REST only |

Opedd is the **licensed content delivery layer** for AI — not just a licensing wrapper. Publishers upload content, you retrieve it via API with a license attached. One integration gives your pipeline both the content and the legal right to use it.

## Learn more

- [Opedd for AI Agents](https://opedd.com/for-ai-agents?utm_source=github&utm_medium=readme&utm_campaign=mcp) — full documentation, code examples, endpoint reference
- [API Docs](https://docs.opedd.com) — OpenAPI spec with agent endpoints
- [Verify a licence](https://opedd.com/verify?utm_source=github&utm_medium=readme&utm_campaign=mcp) — check any licence key in the public record

## License

MIT
