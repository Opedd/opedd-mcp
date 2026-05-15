#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const API_BASE =
  process.env.OPEDD_API_URL ??
  "https://api.opedd.com";

const BUYER_EMAIL = process.env.OPEDD_BUYER_EMAIL;
const PAYMENT_METHOD_ID = process.env.OPEDD_PAYMENT_METHOD_ID;
const API_KEY = process.env.OPEDD_API_KEY; // publisher API key (op_...)
const BUYER_TOKEN = process.env.OPEDD_BUYER_TOKEN; // buyer API token (opedd_buyer_live_... or bk_live_...)
const ACCESS_KEY = process.env.OPEDD_ACCESS_KEY; // enterprise access key (eak_*); for /enterprise-license GET feed
const BUYER_JWT = process.env.OPEDD_BUYER_JWT; // Supabase JWT; for /buyer-audit + /buyer-compliance-report

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function opeddFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(url, { ...options, headers });
  const body = await res.json();
  if (!res.ok) {
    const msg = (body as any)?.error || (body as any)?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// Fetch an NDJSON endpoint and collect parsed lines into an array.
// Last line is typically `{"_meta": {...}}`; surfaced as `meta` field on the
// returned object so the MCP tool result has both shape pieces inline.
async function opeddFetchNdjson(
  path: string,
  options: RequestInit = {},
): Promise<{ articles: unknown[]; meta: unknown }> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/x-ndjson",
    ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      msg = (errBody as any)?.error || (errBody as any)?.message || msg;
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
  // ─── Phase 10 + 11 buyer-side surfaces (M6.4) ─────────────────────────────
  {
    name: "purchase_enterprise_license",
    description:
      "Purchase a bulk enterprise license covering multiple publishers (Phase 10). " +
      "Returns a Stripe client_secret for payment completion + the enterprise_license_id. " +
      "After payment, an eak_* access key is emailed to buyer_email. " +
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
if (BUYER_TOKEN) {
  TOOLS.push({
    name: "get_content",
    description:
      "Retrieve the full body of a licensed article using a buyer API token (opedd_buyer_live_* canonical post-5.2.1a; bk_live_* legacy). " +
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
          description: "Buyer API token (opedd_buyer_live_* or bk_live_*). Falls back to OPEDD_BUYER_TOKEN env var.",
        },
      },
    },
  });
}

// If an enterprise access key is configured, expose feed tools
if (ACCESS_KEY) {
  TOOLS.push({
    name: "list_feed",
    description:
      "List articles from a buyer's licensed catalog via GET /enterprise-license (Phase 10 + 11). " +
      "Returns JSON-format response with paginated articles. " +
      "Use `since` (ISO 8601) for delta-feed polling — only articles published after the timestamp. " +
      "Use `cursor` for pagination across pages. " +
      "Requires OPEDD_ACCESS_KEY (eak_* enterprise access key). " +
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
          description: "Opaque cursor from prior response's _meta.next_cursor",
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
      "Requires OPEDD_ACCESS_KEY (eak_*).",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO 8601 timestamp — return only articles with published_at > since",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from prior response's _meta.next_cursor",
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
if (BUYER_JWT) {
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
if (API_KEY) {
  TOOLS.push({
    name: "list_publisher_content",
    description:
      "List all licensable articles for the authenticated publisher (requires OPEDD_API_KEY). " +
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
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "opedd-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      // ── lookup_content ─────────────────────────────────────────────────────
      case "lookup_content": {
        const { url } = args as { url: string };
        if (!url) return err("url is required");

        const data = await opeddFetch(
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

        const buyerEmail = argEmail || BUYER_EMAIL;
        if (!buyerEmail) {
          return err("buyer_email is required (or set the OPEDD_BUYER_EMAIL env var)");
        }

        const paymentMethodId = argPm || PAYMENT_METHOD_ID;
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

        const data = await opeddFetch("/agent-purchase", {
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

        const data = await opeddFetch(`/registry?${params.toString()}`);
        return ok(data);
      }

      // ── get_content ────────────────────────────────────────────────────────
      case "get_content": {
        const { article_id, buyer_token: argToken } = args as {
          article_id: string;
          buyer_token?: string;
        };
        if (!article_id) return err("article_id is required");

        const token = argToken || BUYER_TOKEN;
        if (!token) {
          return err(
            "buyer_token is required (or set the OPEDD_BUYER_TOKEN env var). " +
            "Create a token at opedd.com/licenses after purchasing a license."
          );
        }

        const data = await opeddFetch(
          `/content-delivery?article_id=${encodeURIComponent(article_id)}`,
          { headers: { Authorization: `Bearer ${token}` } }
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

        const data = await opeddFetch("/enterprise-license", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return ok(data);
      }

      // ── list_feed (Phase 10 + 11) ──────────────────────────────────────────
      case "list_feed": {
        if (!ACCESS_KEY) {
          return err("OPEDD_ACCESS_KEY env var is required for this tool (eak_* enterprise access key)");
        }
        const { since, cursor, limit = 50 } = args as {
          since?: string;
          cursor?: string;
          limit?: number;
        };
        const params = new URLSearchParams({
          access_key: ACCESS_KEY,
          format: "json",
          limit: String(Math.min(Number(limit) || 50, 200)),
        });
        if (since) params.set("since", since);
        if (cursor) params.set("cursor", cursor);

        const data = await opeddFetch(`/enterprise-license?${params.toString()}`);
        return ok(data);
      }

      // ── stream_feed_ndjson (Phase 11 M3) ───────────────────────────────────
      case "stream_feed_ndjson": {
        if (!ACCESS_KEY) {
          return err("OPEDD_ACCESS_KEY env var is required for this tool (eak_* enterprise access key)");
        }
        const { since, cursor, limit = 200 } = args as {
          since?: string;
          cursor?: string;
          limit?: number;
        };
        const params = new URLSearchParams({
          access_key: ACCESS_KEY,
          format: "ndjson",
          limit: String(Math.min(Number(limit) || 200, 1000)),
        });
        if (since) params.set("since", since);
        if (cursor) params.set("cursor", cursor);

        const data = await opeddFetchNdjson(`/enterprise-license?${params.toString()}`);
        return ok(data);
      }

      // ── get_audit_events (Phase 9.x + 10 M5 attestation) ───────────────────
      case "get_audit_events": {
        if (!BUYER_JWT) {
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

        const data = await opeddFetch(`/buyer-audit?${params.toString()}`, {
          headers: { Authorization: `Bearer ${BUYER_JWT}` },
        });
        return ok(data);
      }

      // ── get_compliance_dossier (Phase 11 M4) ───────────────────────────────
      case "get_compliance_dossier": {
        if (!BUYER_JWT) {
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

        const data = await opeddFetch(`/buyer-compliance-report?${params.toString()}`, {
          headers: { Authorization: `Bearer ${BUYER_JWT}` },
        });
        return ok(data);
      }

      // ── list_publisher_content ─────────────────────────────────────────────
      case "list_publisher_content": {
        if (!API_KEY) {
          return err("OPEDD_API_KEY env var is required for this tool");
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

        const data = await opeddFetch(`/api?${params.toString()}`);
        return ok(data);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Request failed: ${msg}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[opedd-mcp] Server running on stdio");
