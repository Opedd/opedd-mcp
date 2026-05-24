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
    // browse_registry, publisher_directory, purchase_enterprise_license,
    // rsl_get, detect_platform
    expect(names).toContain("lookup_content");
    expect(names).toContain("purchase_license");
    expect(names).toContain("verify_license");
    expect(names).toContain("browse_registry");
    expect(names).toContain("publisher_directory");
    expect(names).toContain("purchase_enterprise_license");
    expect(names).toContain("rsl_get");
    expect(names).toContain("detect_platform");
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  it("every tool carries name + description + inputSchema", async () => {
    const { TOOLS } = await loadDispatcher();
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
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
      license_type: "ai",
    });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("/agent-purchase");
    const opts = calls[0][1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    // Env fallback supplies buyer_email + payment.payment_method_id
    expect(body.buyer_email).toBe(TEST_BUYER_EMAIL);
    expect(body.payment.payment_method_id).toBe(TEST_PM_ID);
    expect(body.license_type).toBe("ai");
  });

  it("rejects missing article_url AND article_id", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("purchase_license", { license_type: "ai" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("article_url or article_id");
  });

  it("rejects missing buyer_email when env not set", async () => {
    vi.unstubAllEnvs();
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("purchase_license", {
      article_id: "art-1",
      license_type: "ai",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("buyer_email");
  });
});

// ───────────────────────────── purchase_enterprise_license ─────────────────────────────

describe("dispatchTool: purchase_enterprise_license", () => {
  it("happy path — defaults billing_type=annual, license_tier=rag, scope=custom", async () => {
    const f = mockFetchOk({
      success: true,
      data: { enterprise_license_id: "lic-1", stripe_client_secret: "cs_..." },
    });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("purchase_enterprise_license", {
      publisher_ids: ["pub-1"],
      buyer_email: "eng@yourlab.com",
      buyer_org: "AI Lab",
    });
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("/enterprise-license");
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body.billing_type).toBe("annual");
    expect(body.license_tier).toBe("rag");
    expect(body.scope).toBe("custom");
  });

  it("requires publisher_ids for scope='custom'", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("purchase_enterprise_license", {
      buyer_email: "x",
      buyer_org: "y",
      scope: "custom",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("publisher_ids");
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
