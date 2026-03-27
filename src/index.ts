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
  "https://djdzcciayennqchjgybx.supabase.co/functions/v1";

const BUYER_EMAIL = process.env.OPEDD_BUYER_EMAIL;
const PAYMENT_METHOD_ID = process.env.OPEDD_PAYMENT_METHOD_ID;
const API_KEY = process.env.OPEDD_API_KEY; // publisher API key (op_...)
const BUYER_TOKEN = process.env.OPEDD_BUYER_TOKEN; // buyer API token (bk_live_...)

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
];

// If a buyer token is configured, expose content delivery tooling
if (BUYER_TOKEN) {
  TOOLS.push({
    name: "get_content",
    description:
      "Retrieve the full body of a licensed article using a buyer API token (bk_live_...). " +
      "Requires OPEDD_BUYER_TOKEN env var (create one at opedd.com/licenses after purchasing). " +
      "Works for per-article licenses (token scoped to that article) and archive licenses (token covers all publisher content). " +
      "The publisher must have content delivery enabled and must have pushed content for the article.",
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
          description: "Buyer API token (bk_live_...). Falls back to OPEDD_BUYER_TOKEN env var.",
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
  { name: "opedd-mcp", version: "0.1.0" },
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
