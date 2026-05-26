# opedd-mcp

Licensed content retrieval for AI agents via [MCP (Model Context Protocol)](https://modelcontextprotocol.io). The alternative to unlicensed web scraping for RAG pipelines, AI search, and LLM grounding.

Lets AI assistants (Claude Desktop, Cursor, Windsurf, or any MCP-compatible host) discover, purchase, and verify content licenses autonomously — mid-conversation, without opening a browser. Every license is registered on-chain (Tempo blockchain) with cryptographic proof.

**Unlike generic search APIs**, Opedd returns content with a verifiable license key — defensible under the EU AI Act and any copyright jurisdiction.

## What it does

Exposes up to 16 tools to any AI assistant (some are conditional on env vars):

**Always available — discovery + per-article purchase + onboarding + rights signaling**

| Tool | Description |
|------|-------------|
| `lookup_content` | Look up an article by URL — returns title, publisher, pricing |
| `purchase_license` | Buy a single-article license via Stripe — returns OP-XXXX-XXXX key |
| `verify_license` | Verify a license key — returns validity, article, publisher, blockchain proof |
| `browse_registry` | Browse the public Opedd registry — lists issued LICENSES (use `publisher_directory` to browse publishers themselves) |
| `publisher_directory` | Browse the public Opedd publisher catalog — paginated publishers with article counts + pricing + sample articles (primary buyer-discovery surface for AI labs) |
| `purchase_enterprise_license` | Buy a bulk enterprise license covering multiple publishers (Phase 10) — returns Stripe `client_secret` |
| `rsl_get` | Fetch a publisher's RSL Standard manifest — public discovery surface; `jsonld: true` returns CDSM Article 4(3) signed receipt (Phase 12 W1.1) |
| `detect_platform` | Detect the content platform behind a URL — returns suggested onboarding workflow for Substack / Beehiiv / Ghost / Medium / Brevo / custom (Phase 12 W3.1) |

**Requires `OPEDD_BUYER_TOKEN` (opedd_buyer_live_*)**

| Tool | Description |
|------|-------------|
| `get_content` | Retrieve a licensed article — includes 7 Phase 11 M2 RAG metadata fields (author, language, word_count, content_hash, image_urls, canonical_url, tags) |

**Requires `OPEDD_ACCESS_KEY` (ent_*) — buyer-side feed surfaces**

| Tool | Description |
|------|-------------|
| `list_feed` | List articles from a buyer's licensed catalog with `since` delta-feed support (Phase 11 M5) |
| `stream_feed_ndjson` | Bulk-export up to 1000 articles per call via NDJSON wire format (Phase 11 M3) |

**Requires `OPEDD_BUYER_JWT` (Supabase JWT) — buyer account + audit + compliance + EU AI Act surfaces**

| Tool | Description |
|------|-------------|
| `get_buyer_account` | Fetch buyer profile + masked API key list — buyer-dashboard mental model |
| `get_audit_events` | Per-event audit ledger with Tempo on-chain attestation inclusion proofs inline (Phase 9.x + 10 M5) |
| `get_compliance_dossier` | Procurement-defense compliance dossier mapping retrievals to license terms (Phase 11 M4) |
| `article_53_attestation` | Signed JWT attesting EU AI Act Article 53(1)(d) compliance for a license — the artifact AI labs hand to legal/procurement (Phase 12 W1.4) |

**Requires `OPEDD_PUB_BEARER` (opedd_pub_*) — publisher-side**

| Tool | Description |
|------|-------------|
| `list_publisher_content` | List your own articles with pricing and stats |

### Regulatory framing (CDSM Article 4 vs EU AI Act Article 53 — never conflated)

Per the [opedd-backend INVARIANTS.md W1.6 amendment](https://github.com/Opedd/opedd-backend/blob/main/INVARIANTS.md):

- **`rsl_get(publisher_id, jsonld=true)`** → publisher-side **CDSM Article 4(3)** opt-out declaration (signed JSON-LD receipt over the reservation state).
- **`article_53_attestation(license_id)`** → buyer-side **EU AI Act Article 53** attestation (signed HS256 JWT scoped to one license).
- **`get_compliance_dossier(from, to)`** → comprehensive procurement-defense dossier covering BOTH frameworks (publisher CDSM reservation honored + buyer Article 53 evidence chain).

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
| `OPEDD_BUYER_TOKEN` | Optional | Buyer API token (`opedd_buyer_live_*` canonical; `opedd_buyer_test_*` for sandbox) — enables `get_content` |
| `OPEDD_ACCESS_KEY` | Optional | Enterprise access key (`ent_*`) — enables `list_feed` + `stream_feed_ndjson` |
| `OPEDD_BUYER_JWT` | Optional | Supabase session JWT from the buyer portal — enables `get_audit_events` + `get_compliance_dossier` |
| `OPEDD_PUB_BEARER` | Optional | Canonical Publisher API Bearer key (`opedd_pub_<env>_<32-hex>`; issued via `POST /publishers-api-keys action=create_api_key`) — enables `list_publisher_content`. **v0.4.0 canonical.** |
| `OPEDD_API_KEY` | Deprecated | Legacy Publisher API key (`op_...`) — fallback during the transition window; will stop working when opedd-backend Phase C deploys. Migrate to `OPEDD_PUB_BEARER`. |
| `OPEDD_API_URL` | Optional | Override the API base URL (default: Opedd production) |

> **Getting a Stripe payment method ID**: Save a card in your Stripe account and retrieve the `pm_...` ID via the [Stripe API](https://stripe.com/docs/api/payment_methods).

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

> "Generate an EU AI Act Article 53 attestation JWT for our license `11111111-...` covering the last 90 days. I need the artifact for our procurement audit committee." — uses `article_53_attestation` (requires `OPEDD_BUYER_JWT`)

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
| **What you get** | Licensed content + license key + on-chain proof — all in one API call | Scraped web content, no rights |
| **Content delivery** | Full article text delivered via API (JSON), real-time feed via webhooks | Scraped snippets or full-page dumps |
| **Content quality** | Curated publisher content (niche B2B newsletters, expert analysis) | Whatever's on the open web |
| **Rights** | Verifiable license key per article, publisher-authorized | No rights clearance |
| **Proof** | On-chain (Tempo blockchain) — independently verifiable | None |
| **EU AI Act** | Compliant — full training data provenance chain | No provenance |
| **Pricing** | Publisher sets their own price per article | Platform decides |
| **Delivery modes** | Per-article API, bulk feed (JSON firehose), buyer webhooks (push) | Query-response only |
| **Protocol** | REST + MCP native | REST only |

Opedd is the **licensed content delivery layer** for AI — not just a licensing wrapper. Publishers upload content, you retrieve it via API with a license attached. One integration gives your pipeline both the content and the legal right to use it.

## Learn more

- [Opedd for AI Agents](https://opedd.com/for-ai-agents) — full documentation, code examples, endpoint reference
- [API Docs](https://docs.opedd.com) — OpenAPI spec with agent endpoints
- [Opedd Registry](https://opedd.com/registry) — browse on-chain license proofs

## License

MIT
