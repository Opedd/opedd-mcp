#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { initTelemetry, captureToolCall, shutdownTelemetry } from "./telemetry.js";
import { SERVER_VERSION } from "./version.js";

// ─── Configuration ────────────────────────────────────────────────────────────

// ─── Credentials context (2026-07-11 hosted-gateway refactor) ────────────────
// Credentials travel EXPLICITLY through dispatchTool/opeddFetch instead of
// module-level env constants. Why: the hosted gateway (mcp.opedd.com) serves
// many users from one isolate — module-global creds would cross-contaminate
// concurrent requests (the data-leak class the MCP SDK >=1.26 warns about).
// The stdio bin builds ENV_CREDS once from process.env — behavior-identical
// to the pre-refactor constants; the gateway builds one per request from
// Authorization headers.
export interface Credentials {
  apiBase: string;
  buyerEmail?: string;
  paymentMethodId?: string;
  /** canonical opedd_pub_<env>_<32-hex> key */
  pubBearer?: string;
  /** LEGACY op_<32-hex> — retiring per backend Phase C */
  apiKey?: string;
  /** buyer API token (opedd_buyer_live_/_test_) */
  buyerToken?: string;
  /** enterprise access key (ent_*) — /enterprise-license GET feed */
  accessKey?: string;
  /** Supabase JWT — buyer-audit + compliance + Article 53 surfaces */
  buyerJwt?: string;
}

export function envCredentials(): Credentials {
  return {
    apiBase: process.env.OPEDD_API_URL ?? "https://api.opedd.com",
    buyerEmail: process.env.OPEDD_BUYER_EMAIL,
    paymentMethodId: process.env.OPEDD_PAYMENT_METHOD_ID,
    // B91 v0.4.0 (2026-05-26): OPEDD_PUB_BEARER canonical; OPEDD_API_KEY is
    // the legacy op_ alias during the dual-mode transition window.
    pubBearer: process.env.OPEDD_PUB_BEARER,
    apiKey: process.env.OPEDD_API_KEY,
    buyerToken: process.env.OPEDD_BUYER_TOKEN,
    accessKey: process.env.OPEDD_ACCESS_KEY,
    buyerJwt: process.env.OPEDD_BUYER_JWT,
  };
}

const ENV_CREDS: Credentials = envCredentials();

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// 30s cap (2026-07-10 hardening audit): without it a hung api.opedd.com
// call hangs the agent's tool call indefinitely — an MCP server must fail
// fast so the agent can recover.
const FETCH_TIMEOUT_MS = 30_000;

async function opeddFetch(creds: Credentials, path: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${creds.apiBase}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // B91 v0.4.0 (2026-05-26): canonical Bearer preferred; legacy X-API-Key
    // accepted only as fallback during transition window
    ...(creds.pubBearer ? { Authorization: `Bearer ${creds.pubBearer}` } : (creds.apiKey ? { "X-API-Key": creds.apiKey } : {})),
    ...(options.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // Check ok BEFORE parsing (2026-07-10 hardening): an HTML 502/504 from the
  // proxy must surface as "HTTP 502", not a JSON SyntaxError.
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      // Backend envelope upgraded to structured errors ({ error: { code,
      // message } }); the old string-shape is kept as fallback. Passing the
      // object into Error() rendered "[object Object]" — every agent-facing
      // failure was unreadable (launch-gaps follow-on, 2026-07-17).
      const e = (errBody as any)?.error;
      msg =
        (typeof e === "object" && e !== null ? [e.code, e.message].filter(Boolean).join(": ") : e) ||
        (errBody as any)?.message ||
        msg;
    } catch {
      // non-JSON error body — keep the HTTP-status default
    }
    throw new Error(msg);
  }
  return await res.json();
}

// Fetch an NDJSON endpoint and collect parsed lines into an array.
// Last line is typically `{"_meta": {...}}`; surfaced as `meta` field on the
// returned object so the MCP tool result has both shape pieces inline.
async function opeddFetchNdjson(
  creds: Credentials,
  path: string,
  options: RequestInit = {},
): Promise<{ articles: unknown[]; meta: unknown }> {
  const url = `${creds.apiBase}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/x-ndjson",
    // B91 v0.4.0 (2026-05-26): canonical Bearer preferred; legacy fallback
    ...(creds.pubBearer ? { Authorization: `Bearer ${creds.pubBearer}` } : (creds.apiKey ? { "X-API-Key": creds.apiKey } : {})),
    ...(options.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      // Backend envelope upgraded to structured errors ({ error: { code,
      // message } }); the old string-shape is kept as fallback. Passing the
      // object into Error() rendered "[object Object]" — every agent-facing
      // failure was unreadable (launch-gaps follow-on, 2026-07-17).
      const e = (errBody as any)?.error;
      msg =
        (typeof e === "object" && e !== null ? [e.code, e.message].filter(Boolean).join(": ") : e) ||
        (errBody as any)?.message ||
        msg;
    } catch {
      // non-JSON error body — keep the HTTP-status default
    }
    throw new Error(msg);
  }
  const text = await res.text();
  const articles: unknown[] = [];
  let meta: unknown = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const row = JSON.parse(line) as { _meta?: unknown };
    if (row._meta !== undefined) {
      meta = row._meta;
    } else {
      articles.push(row);
    }
  }
  return { articles, meta };
}

// ─── MCP response helpers ─────────────────────────────────────────────────────

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

function buildTools(has: { buyerToken?: boolean; accessKey?: boolean; buyerJwt?: boolean; pubBearer?: boolean }): Tool[] {
  const TOOLS: Tool[] = [
  {
    name: "lookup_content",
    description:
      "Look up a piece of content on the Opedd registry by URL. " +
      "Returns the article title, publisher, available license types, and pricing " +
      "(human republication price and AI training/inference price). " +
      "Always call this first to check if content is licensable and what it costs.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "The canonical URL of the article or content to look up",
        },
      },
    },
  },
  {
    name: "purchase_license",
    description:
      "Purchase a content license from the Opedd protocol using a Stripe payment method. " +
      "Returns a license key (format: OP-XXXX-XXXX) and a certificate URL. " +
      "The buyer receives a Handshake Email with their license key. " +
      "Set OPEDD_BUYER_EMAIL and OPEDD_PAYMENT_METHOD_ID env vars to avoid passing them on every call. " +
      "License types: 'human' = republication rights, 'ai' = training dataset rights, 'ai_inference' = inference/RAG rights.",
    inputSchema: {
      type: "object",
      required: ["license_type"],
      properties: {
        article_url: {
          type: "string",
          description: "URL of the article to license (use this OR article_id)",
        },
        article_id: {
          type: "string",
          description: "Opedd article UUID (use this OR article_url)",
        },
        license_type: {
          type: "string",
          enum: ["human", "ai", "ai_inference"],
          description:
            "human = republication/editorial rights, ai = training dataset rights, ai_inference = inference/RAG rights",
        },
        buyer_email: {
          type: "string",
          description: "Email address for the license. Falls back to OPEDD_BUYER_EMAIL env var.",
        },
        buyer_name: {
          type: "string",
          description: "Full name of the buyer (for the license record and certificate)",
        },
        buyer_organization: {
          type: "string",
          description: "Organization or company name (for enterprise/editorial licenses)",
        },
        intended_use: {
          type: "string",
          enum: ["personal", "editorial", "commercial", "ai_training", "corporate"],
          description: "Intended use of the licensed content",
        },
        payment_method_id: {
          type: "string",
          description:
            "Stripe payment method ID (pm_...). Falls back to OPEDD_PAYMENT_METHOD_ID env var.",
        },
      },
    },
  },
  {
    name: "verify_license",
    description:
      "Verify the authenticity of an Opedd license key. " +
      "Returns license details including: article title, publisher, license type, " +
      "issue date, amount paid, buyer info, and blockchain proof status. " +
      "Use this to confirm a license is valid before using licensed content.",
    inputSchema: {
      type: "object",
      required: ["license_key"],
      properties: {
        license_key: {
          type: "string",
          description: "The license key to verify (format: OP-XXXX-XXXX)",
        },
      },
    },
  },
  {
    name: "browse_registry",
    description:
      "Browse the public Opedd license registry. " +
      "Returns recently issued licenses and licensable content. " +
      "Filter by publisher_id to explore all content from a specific publisher. " +
      "Filter by article_id to see all licenses issued for a specific article.",
    inputSchema: {
      type: "object",
      properties: {
        publisher_id: {
          type: "string",
          description: "Filter results to a specific publisher (UUID)",
        },
        article_id: {
          type: "string",
          description: "Filter results to a specific article (UUID)",
        },
        limit: {
          type: "number",
          description: "Number of results to return (default: 10, max: 50)",
        },
      },
    },
  },
  // ─── Public buyer-discovery — catalog browse ──────────────────────────────
  {
    name: "publisher_directory",
    description:
      "Browse the public Opedd publisher catalog via GET /publisher-directory. " +
      "Returns paginated publishers with article counts, pricing (per-article + annual + monthly-forward-feed), " +
      "plan, and sample articles (RAG-extended metadata). " +
      "**The primary discovery surface for AI labs to find Opedd-licensable publishers** — distinct from " +
      "`browse_registry` (which lists issued LICENSES, not publishers). " +
      "Filter by category (case-insensitive substring), min_articles, or verified status. " +
      "Public no-auth — useful pre-purchase scoping before buyers commit to enterprise-license POST.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Case-insensitive substring filter on publisher category (e.g. 'finance', 'AI').",
        },
        min_articles: {
          type: "number",
          description: "Filter to publishers with at least this many licensable articles.",
        },
        verified: {
          type: "string",
          description: "'true' to show only verified publishers (default), 'false' for unverified.",
        },
        limit: {
          type: "number",
          description: "Page size cap.",
        },
        offset: {
          type: "number",
          description: "Pagination offset.",
        },
      },
    },
  },
  // ─── Phase 12 Wave 3 W3.1 — onboarding helpers ────────────────────────────
  {
    name: "detect_platform",
    description:
      "Detect the content platform behind a URL via POST /detect-platform (Phase 12 Wave 3 W3.1). " +
      "Public no-auth lookup. Given a URL, identifies what platform powers it " +
      "(Substack / Beehiiv / Ghost / Medium / Brevo / custom) and returns the suggested onboarding workflow. " +
      "Hostname-detectable platforms (Substack subdomain, Beehiiv suffix, etc.) resolve in milliseconds; " +
      "custom domains may take ~few seconds while the detector probes well-known platform endpoints in parallel. " +
      "Returns: {platform, confidence, archive_method, forward_method, required_credentials, instructions}. " +
      "The archive_method + forward_method fields are the two onboarding-workflow inputs Opedd's setup wizard reads " +
      "(one for historical content backfill, one for new-content forward stream). " +
      "instructions is human-readable operator copy explaining the inferred path.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Publisher URL to inspect (any well-formed URL works; hostname-match short-circuits the probe path).",
        },
      },
    },
  },
  // ─── Phase 12 Wave 1 W1.1 — public RSL Standard manifest ─────────────────
  {
    name: "rsl_get",
    description:
      "Fetch a publisher's RSL Standard manifest via GET /rsl-manifest (Phase 12 Wave 1 W1.1). " +
      "Public no-auth endpoint — discovery surface for AI agents/crawlers wanting to know what's licensable " +
      "from a publisher BEFORE going through the buyer-account signup flow. " +
      "Returns the 4 canonical license types (ai_retrieval, ai_training, human_per_article, human_full_archive) " +
      "the publisher has opted into, plus the EU CDSM Article 4(3) opt-out posture (`tdm_reservation`). " +
      "Set `jsonld: true` to request the JSON-LD shape with embedded HMAC-SHA256 signed receipt over the " +
      "CDSM Article 4(3) reservation state + `tdm:reservationSignedAt` timestamp — regulators can post-hoc " +
      "verify the reservation was the claimed value at the claimed time. Default `jsonld: false` returns " +
      "the raw RSL Standard JSON manifest. " +
      "Per INVARIANTS.md W1.6: this is the PUBLISHER-side CDSM Article 4(3) declaration surface. It is NOT " +
      "an EU AI Act Article 53 attestation (which is buyer-side, JWT-auth, via article_53_attestation tool).",
    inputSchema: {
      type: "object",
      required: ["publisher_id"],
      properties: {
        publisher_id: {
          type: "string",
          description: "UUID of the publisher whose RSL manifest to fetch. Publisher must be verified.",
        },
        jsonld: {
          type: "boolean",
          description:
            "If true, request JSON-LD shape (Accept: application/ld+json) with embedded HMAC-SHA256 signed receipt. " +
            "Default false returns raw RSL Standard JSON shape.",
        },
      },
    },
  },
  // ─── Phase 10 + 11 buyer-side surfaces (M6.4) ─────────────────────────────
  {
    name: "purchase_enterprise_license",
    description:
      "Purchase a bulk enterprise license covering multiple publishers (Phase 10). " +
      "Returns a Stripe client_secret for payment completion + the enterprise_license_id. " +
      "After payment, an ent_* access key is emailed to buyer_email. " +
      "Scopes: 'custom' (pass-through publisher_ids), 'platform_wide' (auto-resolve all opted-in publishers), 'filtered' (Phase 10 filter_rules). " +
      "License tiers: 'rag' (= ai_retrieval), 'training' (= ai_training, flat-fee not metered), 'inference' (= ai_retrieval), 'full_ai' (writes both retrieval + training records).",
    inputSchema: {
      type: "object",
      required: ["publisher_ids", "buyer_email", "buyer_org"],
      properties: {
        publisher_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of publisher UUIDs. Required for scope='custom'; ignored for platform_wide/filtered (resolved server-side).",
        },
        buyer_email: {
          type: "string",
          description: "Email to deliver the access key after payment",
        },
        buyer_org: {
          type: "string",
          description: "Buyer organization name (for billing + audit ledger)",
        },
        billing_type: {
          type: "string",
          enum: ["annual", "monthly", "annual_plus_monthly"],
          description: "Billing cadence (default: annual)",
        },
        license_tier: {
          type: "string",
          enum: ["rag", "training", "inference", "full_ai"],
          description: "License tier (default: rag)",
        },
        duration_months: {
          type: "number",
          description: "License duration in months (default: 12)",
        },
        scope: {
          type: "string",
          enum: ["custom", "platform_wide", "filtered"],
          description: "Coverage scope (default: custom)",
        },
        filter_rules: {
          type: "object",
          description: "Required when scope='filtered'. See Phase 10 docs for shape: excluded_publisher_ids / direct_license_carveouts / categories / max_price_per_event.",
        },
        buyer_webhook_url: {
          type: "string",
          description: "Optional HMAC-signed webhook for content.published events on covered publishers",
        },
      },
    },
  },
];

// If a buyer token is configured, expose content delivery tooling
  if (has.buyerToken) {
  TOOLS.push({
    name: "get_content",
    description:
      "Retrieve the full body of a licensed article using a buyer API token (opedd_buyer_live_* canonical; opedd_buyer_test_* for sandbox). " +
      "Requires OPEDD_BUYER_TOKEN env var (create one at opedd.com/licenses after purchasing). " +
      "Works for per-article licenses (token scoped to that article) and archive licenses (token covers all publisher content). " +
      "The publisher must have content delivery enabled and must have pushed content for the article. " +
      "Phase 11 M2 RAG-extended shape: response includes 7 RAG-essential metadata fields — author, language, word_count, content_hash, image_urls, canonical_url, tags. " +
      "On pre-2026-05-14 historical articles, optional fields (author/language/image_urls/canonical_url/tags) may be NULL. " +
      "NULL means 'data unavailable for this article', NOT 'explicitly empty' — treat as data-missing when filtering; do not interpret as anti-match.",
    inputSchema: {
      type: "object",
      required: ["article_id"],
      properties: {
        article_id: {
          type: "string",
          description: "The Opedd article UUID to retrieve content for",
        },
        buyer_token: {
          type: "string",
          description: "Buyer API token (opedd_buyer_live_* or opedd_buyer_test_*). Falls back to OPEDD_BUYER_TOKEN env var.",
        },
      },
    },
  });
}

// If an enterprise access key is configured, expose feed tools
  if (has.accessKey) {
  TOOLS.push({
    name: "list_feed",
    description:
      "List articles from a buyer's licensed catalog via GET /enterprise-license (Phase 10 + 11). " +
      "Returns JSON-format response with paginated articles. " +
      "Use `since` (ISO 8601) for delta-feed polling — only articles published after the timestamp. " +
      "Use `cursor` for pagination across pages. " +
      "Requires OPEDD_ACCESS_KEY (ent_* enterprise access key). " +
      "For larger bulk corpus pulls, use stream_feed_ndjson (up to 1000 articles per call vs 200 here).",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO 8601 timestamp — return only articles with published_at > since",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from the prior response's data.pagination.next_cursor",
        },
        limit: {
          type: "number",
          description: "Max articles per response (default: 50, max: 200)",
        },
      },
    },
  });
  TOOLS.push({
    name: "stream_feed_ndjson",
    description:
      "Bulk-export a buyer's licensed catalog via GET /enterprise-license?format=ndjson (Phase 11 M3). " +
      "Returns up to 1000 articles per call (collected from line-delimited JSON wire format). " +
      "Each article emits one usage_records row (analytics-only sentinel 'bulk-export:<request_id>:<article_id>' — not metered-billable per the revenue-model bifurcation invariant). " +
      "Use `since` (ISO 8601) for delta-feed. Use `cursor` to paginate beyond 1000. " +
      "Backend supports 5000 articles per call; the MCP cap is 1000 for transport reasonability. " +
      "Real bulk-ingest pipelines should use the Python SDK (pip install opedd) directly — not via MCP. " +
      "Requires OPEDD_ACCESS_KEY (ent_*).",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO 8601 timestamp — return only articles with published_at > since",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from the prior result's meta.next_cursor",
        },
        limit: {
          type: "number",
          description: "Max articles per response (default: 200, max: 1000)",
        },
      },
    },
  });
}

// If a Supabase buyer JWT is configured, expose audit + compliance tools
  if (has.buyerJwt) {
  TOOLS.push({
    name: "get_audit_events",
    description:
      "Browse per-event audit rows for the authenticated buyer via GET /buyer-audit (Phase 9.x). " +
      "Each row carries license_terms + Tempo on-chain attestation (merkle_root + inclusion_proof when blockchain_status='confirmed'). " +
      "Optional filter by event_type ('content_access', 'bulk_content_access', 'compliance_report_generated'). " +
      "Window cap 30 days (vs 90-day cap on get_compliance_dossier). " +
      "Attestation inclusion proof is included on every row by default — no separate flag needed (M6.4 consolidation per founder ratification: tools 4 + 6 merged into one cleaner mental model). " +
      "Requires OPEDD_BUYER_JWT (Supabase session JWT from the buyer portal).",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "ISO 8601 timestamp lower bound (inclusive)",
        },
        to: {
          type: "string",
          description: "ISO 8601 timestamp upper bound (inclusive)",
        },
        event_type: {
          type: "string",
          enum: ["content_access", "bulk_content_access", "compliance_report_generated"],
          description: "Optional event-class filter",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor for pagination",
        },
        limit: {
          type: "number",
          description: "Max events per response (default: 50, max: 200)",
        },
      },
    },
  });
  TOOLS.push({
    name: "get_buyer_account",
    description:
      "Fetch the authenticated buyer's account profile + masked API key list via GET /buyer-account. " +
      "Returns the enterprise_buyers row (contact_email, buyer_org, created_at, etc.) plus a list of all " +
      "buyer-side API keys with masked prefixes (NEVER plaintext post-issuance — only the 12-char " +
      "key_prefix is returned, e.g. 'opedd_buyer_'). " +
      "Use cases: post-signup verification ('what was just issued to me?'), buyer dashboard mental model " +
      "('what licenses do I currently hold?'), audit prep ('show me the key list before rotation'). " +
      "For full mid-lifecycle license details (filter_rules, billing, payouts), buyers consult the buyer portal at opedd.com/buyer. " +
      "Requires OPEDD_BUYER_JWT.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  });
  TOOLS.push({
    name: "article_53_attestation",
    description:
      "Issue a signed JWT attesting to EU AI Act Article 53 compliance for a specific license via " +
      "GET /eu-ai-act/article-53-attestation (Phase 12 Wave 1 W1.4). " +
      "Returns a freshly-signed HS256 JWT regulators can verify offline against the canonical signing key. " +
      "Embeds: license context, usage-count over the attestation window, the most-recent Tempo Merkle root, " +
      "and canonical claims (iss/sub/iat/exp/jti/aud). " +
      "**The artifact AI labs hand to legal/procurement for EU AI Act Article 53(1)(d) transparency-obligation evidence.** " +
      "Per INVARIANTS.md W1.6: this attests to EU AI Act Article 53 ONLY (buyer-side GPAI-model-provider " +
      "transparency obligation). It does NOT discharge a publisher's CDSM Article 4(3) reservation obligation — " +
      "that lives on the rsl_get tool (jsonld=true variant). Never conflate. " +
      "Optional `content_id` scopes the attestation to one article; default is license-wide. " +
      "Window cap: 365 days. Requires OPEDD_BUYER_JWT.",
    inputSchema: {
      type: "object",
      required: ["license_id"],
      properties: {
        license_id: {
          type: "string",
          description: "UUID of the enterprise_license OR legacy individual license to attest. Buyer must own it.",
        },
        content_id: {
          type: "string",
          description: "Optional UUID of a specific article to scope the attestation. Default: license-wide.",
        },
        window_start: {
          type: "string",
          description: "ISO 8601 lower bound of the attestation window. Default: now - 90 days.",
        },
        window_end: {
          type: "string",
          description: "ISO 8601 upper bound. Default: now. Window may not exceed 365 days (hard cap).",
        },
      },
    },
  });
  TOOLS.push({
    name: "get_compliance_dossier",
    description:
      "Generate a procurement-defense compliance dossier via GET /buyer-compliance-report (Phase 11 M4). " +
      "Per-row dossier shape: 25+ fields including 17 RAG-essential article fields + full license_terms + on_chain_attestation block. " +
      "Bulk envelopes fan out into per-article rows by iterating metadata.article_ids[]. " +
      "Self-audit invariant: every successful call writes one license_events row with event_type='compliance_report_generated' BEFORE returning. " +
      "Window cap: 90 days per call (vs 30-day cap on get_audit_events). For annual audits, paginate via _meta.next_cursor across 4 quarterly windows. " +
      "Compliance framework anchors (boolean flags) map to EU AI Act Article 53, CDSM Article 4(3), on-chain attestation, TDM reservation. " +
      "Requires OPEDD_BUYER_JWT.",
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: {
          type: "string",
          description: "ISO 8601 timestamp lower bound (inclusive)",
        },
        to: {
          type: "string",
          description: "ISO 8601 timestamp upper bound (inclusive). Window cap 90 days.",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor for pagination",
        },
      },
    },
  });
}

// If a publisher API key is configured, expose publisher-specific tooling
  if (has.pubBearer) {
  TOOLS.push({
    name: "list_publisher_content",
    description:
      "List all licensable articles for the authenticated publisher (requires OPEDD_PUB_BEARER, or legacy OPEDD_API_KEY). " +
      "Returns articles with titles, descriptions, pricing, and sales statistics. " +
      "Use article IDs from this list to purchase licenses via purchase_license.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of results (default: 20, max: 100)",
        },
        type: {
          type: "string",
          enum: ["human", "ai"],
          description: "Filter by license type availability",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default: 0)",
        },
      },
    },
  });

  // Supply-side push: onboard a back-catalogue or send new posts directly from
  // the AI assistant — the native companion to the /publishers-content API.
  TOOLS.push({
    name: "push_content",
    description:
      "Push your published articles to Opedd so they can be licensed to AI buyers (requires OPEDD_PUB_BEARER — your opedd_pub_ publisher key). " +
      "Send 1–100 articles per call; batch larger back-catalogues into multiple calls. Each article needs title, url, and html_body — everything else is optional (published_at defaults to now). " +
      "This is the supply-side companion to list_publisher_content: use it to onboard your archive or push new content with no code, straight from your AI assistant.",
    inputSchema: {
      type: "object",
      required: ["articles"],
      properties: {
        articles: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "1–100 articles to push in this call.",
          items: {
            type: "object",
            required: ["title", "url", "html_body"],
            properties: {
              title: { type: "string", description: "Article title (required, ≤500 chars)." },
              url: { type: "string", description: "The article's canonical web address (required)." },
              html_body: { type: "string", description: "Full article content, HTML or plain text (required, ≤200,000 chars)." },
              published_at: { type: "string", description: "ISO-8601 datetime (e.g. 2026-01-15T09:30:00Z). Defaults to now if omitted." },
              description: { type: "string", description: "Short summary (≤500 chars)." },
              author: { type: "string", description: "Author name (≤200 chars)." },
              language: { type: "string", description: "Language code, e.g. \"en\"." },
              tags: { type: "array", items: { type: "string" }, description: "Up to 20 tags." },
              image_urls: { type: "array", items: { type: "string" }, description: "Up to 10 body-image URLs." },
              thumbnail_url: { type: "string", description: "https cover-image URL for the catalog." },
              canonical_url: { type: "string", description: "Canonical URL if different from url." },
              category: { type: "string", description: "Content category." },
              is_paid: { type: "boolean", description: "Whether the article is behind a paywall." },
              audience: { type: "string", enum: ["everyone", "only_free", "only_paid"], description: "Intended audience." },
            },
          },
        },
      },
    },
  });
}
  return TOOLS;
}

// stdio: credential-gated list (only tools the local env can use).
export const TOOLS: Tool[] = buildTools({
  buyerToken: !!ENV_CREDS.buyerToken,
  accessKey: !!ENV_CREDS.accessKey,
  buyerJwt: !!ENV_CREDS.buyerJwt,
  pubBearer: !!(ENV_CREDS.pubBearer || ENV_CREDS.apiKey),
});

// hosted gateway: advertise ALL tools; per-request creds decide what
// actually succeeds (dispatchTool returns a clear error on missing auth).
export const ALL_TOOLS: Tool[] = buildTools({
  buyerToken: true, accessKey: true, buyerJwt: true, pubBearer: true,
});

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "opedd-mcp", version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Anonymous usage telemetry — captures only the tool name, duration, and
  // success flag (see telemetry.ts). Wrapping the runtime handler (not
  // dispatchTool) keeps unit tests, which call dispatchTool directly, silent.
  const start = Date.now();
  const result = await dispatchTool(
    request.params.name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
  );
  // channel:"stdio" lets the channel report separate local (npx) usage from
  // hosted-gateway usage (channel:"gateway"); the Phase-2 hosted trigger
  // counts only the latter.
  captureToolCall(request.params.name, Date.now() - start, result.isError !== true, { channel: "stdio" });
  return result;
});

// ─── Tool dispatcher (exported for unit tests) ────────────────────────────────
//
// Extracted from the inline handler 2026-05-24 EEST as part of the opedd-mcp
// test cohort ship. Behavior-preserving: the server.setRequestHandler above
// is a thin delegation to dispatchTool. Exporting allows unit tests to mock
// global fetch + invoke each tool's handler directly without spawning a
// stdio subprocess.

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  creds: Credentials = ENV_CREDS,
): Promise<ToolResult> {
  try {
    switch (name) {
      // ── lookup_content ─────────────────────────────────────────────────────
      case "lookup_content": {
        const { url } = args as { url: string };
        if (!url) return err("url is required");

        const data = await opeddFetch(
          creds,
          `/lookup-article?url=${encodeURIComponent(url)}`
        );
        return ok(data);
      }

      // ── purchase_license ───────────────────────────────────────────────────
      case "purchase_license": {
        const {
          article_url,
          article_id,
          license_type,
          buyer_email: argEmail,
          buyer_name,
          buyer_organization,
          intended_use,
          payment_method_id: argPm,
        } = args as {
          article_url?: string;
          article_id?: string;
          license_type: string;
          buyer_email?: string;
          buyer_name?: string;
          buyer_organization?: string;
          intended_use?: string;
          payment_method_id?: string;
        };

        if (!article_url && !article_id) {
          return err("Either article_url or article_id is required");
        }

        const buyerEmail = argEmail || creds.buyerEmail;
        if (!buyerEmail) {
          return err("buyer_email is required (or set the OPEDD_BUYER_EMAIL env var)");
        }

        const paymentMethodId = argPm || creds.paymentMethodId;
        if (!paymentMethodId) {
          return err(
            "payment_method_id is required (or set the OPEDD_PAYMENT_METHOD_ID env var). " +
            "Get a Stripe payment method ID by saving a card at stripe.com/docs/api/payment_methods."
          );
        }

        const body: Record<string, unknown> = {
          license_type,
          buyer_email: buyerEmail,
          payment: { method: "stripe_pm", payment_method_id: paymentMethodId },
          ...(article_id ? { article_id } : { article_url }),
          ...(buyer_name ? { buyer_name } : {}),
          ...(buyer_organization ? { buyer_organization } : {}),
          ...(intended_use ? { intended_use } : {}),
        };

        const data = await opeddFetch(creds, "/agent-purchase", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return ok(data);
      }

      // ── verify_license ─────────────────────────────────────────────────────
      case "verify_license": {
        const { license_key } = args as { license_key: string };
        if (!license_key) return err("license_key is required");

        const data = await opeddFetch(
          creds,
          `/verify-license?key=${encodeURIComponent(license_key)}`
        );
        return ok(data);
      }

      // ── browse_registry ────────────────────────────────────────────────────
      case "browse_registry": {
        const { publisher_id, article_id, limit = 10 } = args as {
          publisher_id?: string;
          article_id?: string;
          limit?: number;
        };

        const params = new URLSearchParams();
        if (publisher_id) params.set("publisher_id", publisher_id);
        if (article_id) params.set("article_id", article_id);
        params.set("limit", String(Math.min(Number(limit), 50)));

        const data = await opeddFetch(creds, `/registry?${params.toString()}`);
        return ok(data);
      }

      // ── get_content ────────────────────────────────────────────────────────
      case "get_content": {
        const { article_id, buyer_token: argToken } = args as {
          article_id: string;
          buyer_token?: string;
        };
        if (!article_id) return err("article_id is required");

        const token = argToken || creds.buyerToken;
        if (!token) {
          return err(
            "buyer_token is required (or set the OPEDD_BUYER_TOKEN env var). " +
            "Create a token at opedd.com/licenses after purchasing a license."
          );
        }

        const data = await opeddFetch(
          creds,
          `/content-delivery?article_id=${encodeURIComponent(article_id)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return ok(data);
      }

      // ── publisher_directory (buyer-discovery catalog browse) ───────────────
      case "publisher_directory": {
        const { category, min_articles, verified, limit, offset } = args as {
          category?: string;
          min_articles?: number;
          verified?: string;
          limit?: number;
          offset?: number;
        };
        const params = new URLSearchParams();
        if (category) params.set("category", category);
        if (min_articles !== undefined) params.set("min_articles", String(min_articles));
        if (verified !== undefined) params.set("verified", verified);
        if (limit !== undefined) params.set("limit", String(limit));
        if (offset !== undefined) params.set("offset", String(offset));

        const query = params.toString();
        const data = await opeddFetch(creds, `/publisher-directory${query ? `?${query}` : ""}`);
        return ok(data);
      }

      // ── detect_platform (Phase 12 Wave 3 W3.1) ─────────────────────────────
      case "detect_platform": {
        const { url } = args as { url: string };
        if (!url) return err("url is required");

        const data = await opeddFetch(creds, "/detect-platform", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        return ok(data);
      }

      // ── rsl_get (Phase 12 Wave 1 W1.1) ─────────────────────────────────────
      case "rsl_get": {
        const { publisher_id, jsonld = false } = args as {
          publisher_id: string;
          jsonld?: boolean;
        };
        if (!publisher_id) return err("publisher_id is required");

        const accept = jsonld ? "application/ld+json" : "application/json";
        const data = await opeddFetch(
          creds,
          `/rsl-manifest?publisher_id=${encodeURIComponent(publisher_id)}`,
          { headers: { Accept: accept } },
        );
        return ok(data);
      }

      // ── purchase_enterprise_license (Phase 10) ─────────────────────────────
      case "purchase_enterprise_license": {
        const {
          publisher_ids,
          buyer_email: pelEmail,
          buyer_org,
          billing_type = "annual",
          license_tier = "rag",
          duration_months = 12,
          scope = "custom",
          filter_rules,
          buyer_webhook_url,
        } = args as {
          publisher_ids?: string[];
          buyer_email?: string;
          buyer_org?: string;
          billing_type?: string;
          license_tier?: string;
          duration_months?: number;
          scope?: string;
          filter_rules?: Record<string, unknown>;
          buyer_webhook_url?: string;
        };

        if (!Array.isArray(publisher_ids) || publisher_ids.length === 0) {
          if (scope === "custom") {
            return err("publisher_ids array is required for scope='custom'");
          }
        }
        if (!pelEmail) return err("buyer_email is required");
        if (!buyer_org) return err("buyer_org is required");

        const body: Record<string, unknown> = {
          publisher_ids: publisher_ids ?? [],
          buyer_email: pelEmail,
          buyer_org,
          billing_type,
          license_tier,
          duration_months,
          scope,
          ...(filter_rules ? { filter_rules } : {}),
          ...(buyer_webhook_url ? { buyer_webhook_url } : {}),
        };

        const data = await opeddFetch(creds, "/enterprise-license", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return ok(data);
      }

      // ── list_feed (Phase 10 + 11) ──────────────────────────────────────────
      case "list_feed": {
        if (!creds.accessKey) {
          return err("OPEDD_ACCESS_KEY env var is required for this tool (ent_* enterprise access key)");
        }
        const { since, cursor, limit = 50 } = args as {
          since?: string;
          cursor?: string;
          limit?: number;
        };
        const params = new URLSearchParams({
          access_key: creds.accessKey,
          format: "json",
          limit: String(Math.min(Number(limit) || 50, 200)),
        });
        if (since) params.set("since", since);
        if (cursor) params.set("cursor", cursor);

        const data = await opeddFetch(creds, `/enterprise-license?${params.toString()}`);
        return ok(data);
      }

      // ── stream_feed_ndjson (Phase 11 M3) ───────────────────────────────────
      case "stream_feed_ndjson": {
        if (!creds.accessKey) {
          return err("OPEDD_ACCESS_KEY env var is required for this tool (ent_* enterprise access key)");
        }
        const { since, cursor, limit = 200 } = args as {
          since?: string;
          cursor?: string;
          limit?: number;
        };
        const params = new URLSearchParams({
          access_key: creds.accessKey,
          format: "ndjson",
          limit: String(Math.min(Number(limit) || 200, 1000)),
        });
        if (since) params.set("since", since);
        if (cursor) params.set("cursor", cursor);

        const data = await opeddFetchNdjson(creds, `/enterprise-license?${params.toString()}`);
        return ok(data);
      }

      // ── get_audit_events (Phase 9.x + 10 M5 attestation) ───────────────────
      case "get_audit_events": {
        if (!creds.buyerJwt) {
          return err("OPEDD_BUYER_JWT env var is required for this tool (Supabase session JWT)");
        }
        const { from, to, event_type, cursor, limit = 50 } = args as {
          from?: string;
          to?: string;
          event_type?: string;
          cursor?: string;
          limit?: number;
        };
        const params = new URLSearchParams({
          limit: String(Math.min(Number(limit) || 50, 200)),
        });
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        if (event_type) params.set("event_type", event_type);
        if (cursor) params.set("cursor", cursor);

        const data = await opeddFetch(creds, `/buyer-audit?${params.toString()}`, {
          headers: { Authorization: `Bearer ${creds.buyerJwt}` },
        });
        return ok(data);
      }

      // ── get_buyer_account (buyer profile + masked key list) ────────────────
      case "get_buyer_account": {
        if (!creds.buyerJwt) {
          return err("OPEDD_BUYER_JWT env var is required for this tool (Supabase session JWT)");
        }
        const data = await opeddFetch(creds, "/buyer-account", {
          headers: { Authorization: `Bearer ${creds.buyerJwt}` },
        });
        return ok(data);
      }

      // ── article_53_attestation (Phase 12 Wave 1 W1.4) ──────────────────────
      case "article_53_attestation": {
        if (!creds.buyerJwt) {
          return err("OPEDD_BUYER_JWT env var is required for this tool (Supabase session JWT)");
        }
        const { license_id, content_id, window_start, window_end } = args as {
          license_id: string;
          content_id?: string;
          window_start?: string;
          window_end?: string;
        };
        if (!license_id) return err("license_id is required");

        const params = new URLSearchParams({ license_id });
        if (content_id) params.set("content_id", content_id);
        if (window_start) params.set("window_start", window_start);
        if (window_end) params.set("window_end", window_end);

        // Function name is DASH-separated end to end: the api.opedd.com proxy
        // rewrites /:path* verbatim into /functions/v1/:path*, so the prior
        // slashed "/eu-ai-act/article-53-attestation" resolved to a
        // nonexistent function named "eu-ai-act" and 404'd — this tool had
        // NEVER worked in production until the 2026-07-10 fix (live-probed).
        const data = await opeddFetch(
          creds,
          `/eu-ai-act-article-53-attestation?${params.toString()}`,
          { headers: { Authorization: `Bearer ${creds.buyerJwt}` } },
        );
        return ok(data);
      }

      // ── get_compliance_dossier (Phase 11 M4) ───────────────────────────────
      case "get_compliance_dossier": {
        if (!creds.buyerJwt) {
          return err("OPEDD_BUYER_JWT env var is required for this tool (Supabase session JWT)");
        }
        const { from, to, cursor } = args as {
          from?: string;
          to?: string;
          cursor?: string;
        };
        if (!from) return err("from (ISO 8601 timestamp) is required");
        if (!to) return err("to (ISO 8601 timestamp) is required");

        const params = new URLSearchParams({
          from,
          to,
          format: "json",
        });
        if (cursor) params.set("cursor", cursor);

        const data = await opeddFetch(creds, `/buyer-compliance-report?${params.toString()}`, {
          headers: { Authorization: `Bearer ${creds.buyerJwt}` },
        });
        return ok(data);
      }

      // ── list_publisher_content ─────────────────────────────────────────────
      case "list_publisher_content": {
        if (!creds.pubBearer && !creds.apiKey) {
          return err("OPEDD_PUB_BEARER env var is required for this tool (canonical Bearer; legacy OPEDD_API_KEY also accepted during transition)");
        }

        const { limit = 20, type, offset = 0 } = args as {
          limit?: number;
          type?: string;
          offset?: number;
        };

        const params = new URLSearchParams({ action: "articles" });
        params.set("limit", String(Math.min(Number(limit), 100)));
        params.set("offset", String(Number(offset)));
        if (type) params.set("type", type);

        const data = await opeddFetch(creds, `/api?${params.toString()}`);
        return ok(data);
      }

      // ── push_content ───────────────────────────────────────────────────────
      case "push_content": {
        if (!creds.pubBearer && !creds.apiKey) {
          return err("OPEDD_PUB_BEARER env var is required for this tool (your opedd_pub_ publisher key).");
        }
        const { articles } = args as { articles?: unknown[] };
        if (!Array.isArray(articles) || articles.length === 0) {
          return err("`articles` must be a non-empty array (1–100 items).");
        }
        if (articles.length > 100) {
          return err(`Too many articles in one call (${articles.length}). Send at most 100 per call and batch the rest.`);
        }
        // Backend /publishers-content enforces the full strict schema + returns
        // clear per-article errors; we pass through so the assistant can relay them.
        const data = await opeddFetch(creds, "/publishers-content", {
          method: "POST",
          body: JSON.stringify({ articles }),
        });
        return ok(data);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Request failed: ${msg}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

// Skip stdio bootstrap when imported as a module (unit tests need TOOLS +
// dispatchTool without the server.connect side-effect). Detect via
// `import.meta.url === pathToFileURL(process.argv[1]).href` — the canonical
// "am I the entry point" check for ESM Node modules.
if (
  typeof process !== "undefined" &&
  process.argv?.[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  initTelemetry();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void shutdownTelemetry().finally(() => process.exit(0));
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[opedd-mcp] Server running on stdio");
}
