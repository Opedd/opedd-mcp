// Unit tests for the opedd-mcp tool dispatcher (extracted 2026-05-24 EEST
// as part of the test cohort ship). Mocks globalThis.fetch + invokes
// dispatchTool() directly; no stdio subprocess required.
//
// Pattern mirrors opedd-python's pytest-httpx mocking approach: per-test
// fetch mock returns a controlled response, assertion verifies (a) the
// outbound URL/method/body composition, (b) the dispatcher's
// JSON-stringified ToolResult shape, (c) error mapping for non-2xx.
//
// Covers the 8 always-available tools (no env-var gate required). The 7
// env-gated tools (article_53_attestation, get_buyer_account, list_feed,
// stream_feed_ndjson, get_audit_events, get_compliance_dossier,
// list_publisher_content) are covered in dispatcher.env-gated.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_BUYER_TOKEN = "opedd_buyer_test_unit_abc";
const TEST_BUYER_EMAIL = "unit@opedd-test.com";
const TEST_PM_ID = "pm_test_unit";

// Set the env BEFORE importing the module — fixture-mock pattern.
beforeEach(() => {
  vi.stubEnv("OPEDD_BUYER_TOKEN", TEST_BUYER_TOKEN);
  vi.stubEnv("OPEDD_BUYER_EMAIL", TEST_BUYER_EMAIL);
  vi.stubEnv("OPEDD_PAYMENT_METHOD_ID", TEST_PM_ID);
  vi.stubEnv("OPEDD_API_URL", "https://api.opedd.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function loadDispatcher() {
  // Fresh import per test so env-var-driven branches re-evaluate.
  vi.resetModules();
  const mod = await import("../src/index.ts");
  return mod;
}

function mockFetchOk(body: unknown, status = 200): typeof fetch {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as typeof fetch;
}

function mockFetchErr(body: unknown, status: number): typeof fetch {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as typeof fetch;
}

function parsePayload(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ───────────────────────────── TOOLS array shape ─────────────────────────────

describe("TOOLS array (metadata)", () => {
  it("exports 8 always-available tools (no env-var gate required)", async () => {
    // Clear env-gated vars so only the always-available bucket registers
    vi.unstubAllEnvs();
    vi.stubEnv("OPEDD_BUYER_EMAIL", TEST_BUYER_EMAIL);
    const { TOOLS } = await loadDispatcher();
    const names = TOOLS.map((t) => t.name);
    // Always-available: lookup_content, purchase_license, verify_license,
    // browse_registry, publisher_directory, place_licence_order,
    // rsl_get, detect_platform
    expect(names).toContain("lookup_content");
    expect(names).toContain("purchase_license");
    expect(names).toContain("verify_license");
    expect(names).toContain("browse_registry");
    expect(names).toContain("publisher_directory");
    expect(names).toContain("place_licence_order");
    expect(names).not.toContain("purchase_enterprise_license");
    expect(names).toContain("rsl_get");
    expect(names).toContain("detect_platform");
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  it("every tool carries name + description + inputSchema", async () => {
    const { TOOLS } = await loadDispatcher();
    for (const tool of TOOLS) {
      // digits allowed since article_53_attestation became visible with a
      // buyer token alone (0.6.15 scoped-keys visibility widening)
      expect(tool.name).toMatch(/^[a-z0-9_]+$/);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema?.type).toBe("object");
    }
  });

  it("rsl_get advertises publisher_id required + jsonld optional", async () => {
    const { TOOLS } = await loadDispatcher();
    const tool = TOOLS.find((t) => t.name === "rsl_get");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("publisher_id");
    expect(schema.properties.jsonld).toBeDefined();
  });

  it("detect_platform advertises url required", async () => {
    const { TOOLS } = await loadDispatcher();
    const tool = TOOLS.find((t) => t.name === "detect_platform");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { required?: string[] };
    expect(schema.required).toContain("url");
  });

  it("publisher_directory has no required fields (all filters optional)", async () => {
    const { TOOLS } = await loadDispatcher();
    const tool = TOOLS.find((t) => t.name === "publisher_directory");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required ?? []).toEqual([]);
    expect(schema.properties.category).toBeDefined();
    expect(schema.properties.min_articles).toBeDefined();
  });
});

// ───────────────────────────── lookup_content ─────────────────────────────

describe("dispatchTool: lookup_content", () => {
  it("happy path — sends GET /lookup-article with encoded URL", async () => {
    const f = mockFetchOk({ success: true, data: { id: "art-1", title: "X" } });
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("lookup_content", {
      url: "https://publisher.com/articles/x",
    });
    expect(f).toHaveBeenCalledOnce();
    const call = (f as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(call)).toBe(
      "https://api.opedd.com/lookup-article?url=https%3A%2F%2Fpublisher.com%2Farticles%2Fx",
    );
    const payload = parsePayload(result);
    expect((payload.data as Record<string, unknown>).title).toBe("X");
  });

  it("rejects missing url with error", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("lookup_content", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("url is required");
  });

  it("propagates 404 as error response", async () => {
    mockFetchErr({ success: false, error: "Article not found" }, 404);
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("lookup_content", { url: "https://no.example" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Article not found");
  });
});

// ───────────────────────────── verify_license ─────────────────────────────

describe("dispatchTool: verify_license", () => {
  it("happy path — sends GET /verify-license with encoded key", async () => {
    const f = mockFetchOk({ success: true, data: { key: "OP-1234-5678", blockchain_status: "confirmed" } });
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("verify_license", { license_key: "OP-1234-5678" });
    expect(f).toHaveBeenCalledOnce();
    const call = (f as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(call)).toContain("/verify-license?key=OP-1234-5678");
    const payload = parsePayload(result);
    expect((payload.data as Record<string, unknown>).blockchain_status).toBe("confirmed");
  });

  it("rejects missing license_key", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("verify_license", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("license_key is required");
  });
});

// ───────────────────────────── browse_registry ─────────────────────────────

describe("dispatchTool: browse_registry", () => {
  it("happy path — sends GET /registry with default limit=10", async () => {
    const f = mockFetchOk({ success: true, data: { licenses: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("browse_registry", {});
    const call = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(call).toContain("/registry?limit=10");
  });

  it("limit capped at 50", async () => {
    const f = mockFetchOk({ success: true, data: {} });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("browse_registry", { limit: 999 });
    const call = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(call).toContain("limit=50");
  });

  it("publisher_id filter flows through to query", async () => {
    const f = mockFetchOk({ success: true, data: {} });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("browse_registry", { publisher_id: "8268c353" });
    const call = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(call).toContain("publisher_id=8268c353");
  });
});

// ───────────────────────────── publisher_directory (chip 12) ─────────────────────────────

describe("dispatchTool: publisher_directory", () => {
  it("happy path with all filters — encodes correctly", async () => {
    const f = mockFetchOk({ success: true, data: { publishers: [], total: 0 } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("publisher_directory", {
      category: "finance",
      min_articles: 5,
      verified: "true",
      limit: 20,
      offset: 0,
    });
    const call = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(call).toContain("category=finance");
    expect(call).toContain("min_articles=5");
    expect(call).toContain("verified=true");
    expect(call).toContain("limit=20");
  });

  it("no filters — bare /publisher-directory call", async () => {
    const f = mockFetchOk({ success: true, data: { publishers: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("publisher_directory", {});
    const call = String((f as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(call).toMatch(/\/publisher-directory$/);
  });
});

// ───────────────────────────── rsl_get (chip 1) ─────────────────────────────

describe("dispatchTool: rsl_get", () => {
  it("default jsonld=false — sends Accept: application/json", async () => {
    const f = mockFetchOk({ rsl_version: "1.0", tdm_reservation: true });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("rsl_get", {
      publisher_id: "8268c353-ffa3-4db3-bbb2-90ddbbb43e41",
    });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("/rsl-manifest?publisher_id=");
    const headers = (calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  it("jsonld=true — sends Accept: application/ld+json", async () => {
    const f = mockFetchOk({ "@type": "opedd:CdsmArticle4Reservation" });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("rsl_get", {
      publisher_id: "8268c353-ffa3-4db3-bbb2-90ddbbb43e41",
      jsonld: true,
    });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    const headers = (calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/ld+json");
  });

  it("rejects missing publisher_id", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("rsl_get", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("publisher_id is required");
  });

  it("propagates 404 on unverified publisher", async () => {
    mockFetchErr({ success: false, error: "Publisher not found" }, 404);
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("rsl_get", {
      publisher_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Publisher not found");
  });
});

// ───────────────────────────── detect_platform (chip 3) ─────────────────────────────

describe("dispatchTool: detect_platform", () => {
  it("happy path — POSTs JSON body", async () => {
    const f = mockFetchOk({
      success: true,
      data: { platform: "substack", confidence: "high", archive_method: "email" },
    });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("detect_platform", { url: "https://noahpinion.substack.com" });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("/detect-platform");
    const opts = calls[0][1] as RequestInit;
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ url: "https://noahpinion.substack.com" });
  });

  it("rejects missing url", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("detect_platform", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("url is required");
  });
});

// ───────────────────────────── purchase_license (existing) ─────────────────────────────

describe("dispatchTool: purchase_license", () => {
  it("happy path — POSTs /agent-purchase with buyer_email + payment fallback", async () => {
    const f = mockFetchOk({ success: true, data: { license_key: "OP-1234-5678" } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("purchase_license", {
      article_id: "art-1",
      license_type: "human",
      terms_accepted: true,
    });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("/agent-purchase");
    const opts = calls[0][1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    // Env fallback supplies buyer_email + payment.payment_method_id
    expect(body.buyer_email).toBe(TEST_BUYER_EMAIL);
    expect(body.payment.payment_method_id).toBe(TEST_PM_ID);
    expect(body.license_type).toBe("human");
    // Fail-closed assent (2026-07-24): the tool stamps the acceptance moment.
    expect(typeof body.terms_accepted_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.terms_accepted_at))).toBe(false);
  });

  it("rejects missing terms_accepted (fail-closed assent)", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("purchase_license", {
      article_id: "art-1",
      license_type: "human",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("terms_accepted");
  });

  it("rejects missing article_url AND article_id", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("purchase_license", { license_type: "human" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("article_url or article_id");
  });

  it("rejects missing buyer_email when env not set", async () => {
    vi.unstubAllEnvs();
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("purchase_license", {
      article_id: "art-1",
      license_type: "human",
      terms_accepted: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("buyer_email");
  });
});

// ───────────────────────────── place_licence_order ─────────────────────────────

describe("dispatchTool: place_licence_order", () => {
  it("purchase_license offers Human republication only (AI licences are licence orders)", async () => {
    const { TOOLS } = await loadDispatcher();
    const tool = TOOLS.find((t) => t.name === "purchase_license")!;
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.license_type.enum).toEqual(["human"]);
  });

  it("happy path — POSTs the order body with the buyer session and the current MSA label", async () => {
    vi.stubEnv("OPEDD_BUYER_JWT", "jwt.buyer.session");
    const f = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes("action=trust_facts")
            ? { success: true, data: { agreements: { enterprise_msa_current: "buyer-master-agreement-v5.4" } } }
            : { success: true, data: { order_id: "ord-1", hosted_invoice_url: "https://invoice.stripe.com/i/x" } },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    globalThis.fetch = f as unknown as typeof fetch;
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("place_licence_order", {
      licence: "display",
      billing_mode: "monthly",
      publisher_ids: ["pub-1", "pub-2"],
      quantity: 3,
      terms_accepted: true,
    });
    expect(result.isError).toBeFalsy();
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    // The current agreement is read first, then the order is placed with it.
    expect(calls[0][0]).toBe("https://api.opedd.com/api?action=trust_facts");
    expect(calls[1][0]).toBe("https://api.opedd.com/enterprise-license");
    const init = calls[1][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt.buyer.session");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ licence: "display", billing_mode: "monthly", publisher_ids: ["pub-1", "pub-2"], quantity: 3 });
    expect(body.terms_version).toBe("buyer-master-agreement-v5.4");
    expect(body).not.toHaveProperty("buyer_email");
  });

  it("refuses without a buyer session, without terms_accepted, or without publishers — and calls nothing", async () => {
    const f = mockFetchOk({});
    let { dispatchTool } = await loadDispatcher();
    let result = await dispatchTool("place_licence_order", { licence: "enterprise", billing_mode: "monthly", publisher_ids: ["p"], terms_accepted: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("OPEDD_BUYER_JWT");

    vi.stubEnv("OPEDD_BUYER_JWT", "jwt.buyer.session");
    ({ dispatchTool } = await loadDispatcher());
    result = await dispatchTool("place_licence_order", { licence: "enterprise", billing_mode: "monthly", publisher_ids: ["p"] });
    expect(result.content[0].text).toContain("terms_accepted");
    result = await dispatchTool("place_licence_order", { licence: "enterprise", billing_mode: "monthly", publisher_ids: [], terms_accepted: true });
    expect(result.content[0].text).toContain("publisher_ids");
    expect((f as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe("dispatchTool: list_licence_orders", () => {
  it("lists with the audit-scoped key; reads one order by id", async () => {
    const f = mockFetchOk({ success: true, data: { orders: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("list_licence_orders", { limit: 500 });
    await dispatchTool("list_licence_orders", { order_id: "ord-1" });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("https://api.opedd.com/buyer-orders?limit=100");
    expect(((calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_BUYER_TOKEN}`);
    expect(calls[1][0]).toBe("https://api.opedd.com/buyer-orders?order_id=ord-1");
  });
});

// ───────────────────────────── error mapping + unknown tool ─────────────────────────────

describe("dispatchTool: shared error paths", () => {
  it("unknown tool name returns isError", async () => {
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("definitely_not_a_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("fetch throw (network failure) surfaces as Request failed", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("lookup_content", { url: "https://x.example" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Request failed");
  });

  it("500 error response surfaces error message", async () => {
    mockFetchErr({ error: "Internal" }, 500);
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("lookup_content", { url: "https://x.example" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Internal");
  });
});

// ─────────────────────────── search_passages (OP-B5) ───────────────────────
//
// The PAID question tool. Distinct from search_content, which is free and
// returns no article text. These tests pin the two things a wrong call would
// cost real money or leak: that it POSTs to /search with the buyer's key, and
// that it refuses locally rather than spending a round trip on junk.

describe("dispatchTool: search_passages", () => {
  it("happy path — POSTs the question to /search with the buyer key", async () => {
    const f = mockFetchOk({
      success: true,
      data: {
        request_id: "req_abc",
        passages: [{ text: "<opedd:passage>\nwords\n</opedd:passage>", words: 287 }],
        billing: { charged_cents: 15, publishers_charged: 1 },
      },
    });
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("search_passages", { query: "what is embedded finance" });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://api.opedd.com/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "what is embedded finance" });
    expect(init.headers.Authorization).toBe(`Bearer ${TEST_BUYER_TOKEN}`);

    // The dispatcher unwraps the envelope, so the payload IS the data.
    const payload = parsePayload(result);
    expect(payload.request_id).toBe("req_abc");
    expect((payload.billing as Record<string, unknown>).charged_cents).toBe(15);
  });

  it("normalises whitespace so the same question bills once", async () => {
    // The backend derives the request id from the NORMALISED question; sending
    // ragged whitespace would mint a fresh id and a fresh charge for what is
    // the same question.
    const f = mockFetchOk({ success: true, data: { passages: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("search_passages", { query: "  what   is embedded  finance " });
    const [, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String(init.body)).query).toBe("what is embedded finance");
  });

  it("refuses an empty or too-short question without calling the API", async () => {
    const f = mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    for (const query of ["", "   ", "ab"]) {
      const result = await dispatchTool("search_passages", { query });
      expect(result.isError).toBe(true);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses an over-long question without calling the API", async () => {
    const f = mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("search_passages", { query: "x".repeat(1001) });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at most 1000");
    expect(f).not.toHaveBeenCalled();
  });

  it("prefers an explicitly passed key over the env var", async () => {
    const f = mockFetchOk({ success: true, data: { passages: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("search_passages", { query: "a question", buyer_token: "opedd_buyer_live_explicit" });
    const [, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer opedd_buyer_live_explicit");
  });

  it("surfaces the backend's 403 rather than swallowing it", async () => {
    // A key without the 'search' scope, which is the most likely first failure
    // for a buyer who already had an audit key.
    mockFetchErr({ success: false, error: "This API key does not carry the 'search' scope required here." }, 403);
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("search_passages", { query: "a question" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("search");
  });
});
