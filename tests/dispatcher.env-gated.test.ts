// Env-gated tool tests — covers the 7 tools that register conditionally
// based on env-var presence:
//
//   article_53_attestation, get_buyer_account, get_audit_events,
//   get_compliance_dossier  (require OPEDD_BUYER_JWT)
//   list_feed, stream_feed_ndjson  (require OPEDD_ACCESS_KEY)
//   list_publisher_content  (requires OPEDD_PUB_BEARER OR legacy OPEDD_API_KEY)
//
// Separate file from dispatcher.test.ts because the TOOLS array push +
// CallTool switch cases evaluate env-var presence at module-import time;
// mixing env-set and env-unset tests in the same file requires vitest
// resetModules() round-trips that compound state-leak risk. One file =
// one env-vector for cleaner test isolation.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_BUYER_TOKEN = "opedd_buyer_test_env_gated_xxx";
const TEST_BUYER_JWT = "eyJhbGc.env-gated-test.sig";
const TEST_ACCESS_KEY = "ent_env_gated_test";
const TEST_API_KEY = "op_env_gated_test_pub";
const TEST_PUB_BEARER = "opedd_pub_test_env_gated_test_pub_canonical_xxxx"; // v0.4.0 canonical Bearer
const TEST_BUYER_EMAIL = "env-gated@opedd-test.com";

// Stub ALL env vars before any import — guarantees every conditional
// TOOLS push registers + every env-gated switch case is callable.
beforeAll(() => {
  vi.stubEnv("OPEDD_BUYER_TOKEN", TEST_BUYER_TOKEN);
  vi.stubEnv("OPEDD_BUYER_JWT", TEST_BUYER_JWT);
  vi.stubEnv("OPEDD_ACCESS_KEY", TEST_ACCESS_KEY);
  vi.stubEnv("OPEDD_API_KEY", TEST_API_KEY);
  vi.stubEnv("OPEDD_PUB_BEARER", TEST_PUB_BEARER);
  vi.stubEnv("OPEDD_BUYER_EMAIL", TEST_BUYER_EMAIL);
  vi.stubEnv("OPEDD_API_URL", "https://api.opedd.com");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadDispatcher() {
  vi.resetModules();
  return await import("../src/index.ts");
}

function mockFetchOk(body: unknown, status = 200) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchNdjson(lines: unknown[]): ReturnType<typeof vi.fn> {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const fn = vi.fn(async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

// ───────────────────────────── all env-gated tools register ─────────────────────────────

describe("TOOLS array with all env vars set", () => {
  it("exposes the 7 env-gated tools alongside the 8 always-available", async () => {
    const { TOOLS } = await loadDispatcher();
    const names = TOOLS.map((t) => t.name);
    // BUYER_TOKEN-gated
    expect(names).toContain("get_content");
    // BUYER_JWT-gated
    expect(names).toContain("get_buyer_account");
    expect(names).toContain("article_53_attestation");
    expect(names).toContain("get_audit_events");
    expect(names).toContain("get_compliance_dossier");
    // ACCESS_KEY-gated
    expect(names).toContain("list_feed");
    expect(names).toContain("stream_feed_ndjson");
    // API_KEY-gated
    expect(names).toContain("list_publisher_content");
    expect(names.length).toBe(16);
  });
});

// ───────────────────────────── BUYER_TOKEN-gated tool ─────────────────────────────

describe("dispatchTool: get_content (BUYER_TOKEN gated)", () => {
  it("sends GET /content-delivery with bearer auth", async () => {
    const f = mockFetchOk({ success: true, data: { id: "art-1", content: "..." } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("get_content", { article_id: "art-1" });
    const call = f.mock.calls[0];
    expect(String(call[0])).toContain("/content-delivery?article_id=art-1");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_BUYER_TOKEN}`);
  });
});

// ───────────────────────────── BUYER_JWT-gated tools ─────────────────────────────

describe("dispatchTool: get_buyer_account (BUYER_JWT gated, chip 13)", () => {
  it("sends GET /buyer-account with JWT auth", async () => {
    const f = mockFetchOk({ success: true, data: { buyer: { contact_email: "x" } } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("get_buyer_account", {});
    const call = f.mock.calls[0];
    expect(String(call[0])).toContain("/buyer-account");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_BUYER_JWT}`);
  });
});

describe("dispatchTool: article_53_attestation (BUYER_JWT gated, chip 2)", () => {
  it("happy path — license_id only", async () => {
    const f = mockFetchOk({
      success: true,
      data: { jwt: "eyJ.test.sig", claims: { eu_ai_act_article: 53, aud: "eu-ai-act-article-53" } },
    });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("article_53_attestation", {
      license_id: "11111111-2222-3333-4444-555555555555",
    });
    const call = f.mock.calls[0];
    expect(String(call[0])).toContain(
      "/eu-ai-act/article-53-attestation?license_id=11111111-2222-3333-4444-555555555555",
    );
  });

  it("with all optional params (content_id + window_start + window_end)", async () => {
    const f = mockFetchOk({ success: true, data: {} });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("article_53_attestation", {
      license_id: "11111111-2222-3333-4444-555555555555",
      content_id: "22222222-3333-4444-5555-666666666666",
      window_start: "2026-02-22T00:00:00Z",
      window_end: "2026-05-22T00:00:00Z",
    });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("content_id=22222222");
    expect(call).toContain("window_start=2026-02-22T00%3A00%3A00Z");
    expect(call).toContain("window_end=2026-05-22T00%3A00%3A00Z");
  });

  it("rejects missing license_id", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("article_53_attestation", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("license_id is required");
  });
});

describe("dispatchTool: get_audit_events (BUYER_JWT gated)", () => {
  it("happy path with all filters", async () => {
    const f = mockFetchOk({ success: true, events: [] });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("get_audit_events", {
      from: "2026-05-01",
      to: "2026-05-15",
      event_type: "content_access",
      limit: 50,
    });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("from=2026-05-01");
    expect(call).toContain("event_type=content_access");
    expect(call).toContain("limit=50");
  });

  it("limit capped at 200", async () => {
    const f = mockFetchOk({ success: true, events: [] });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("get_audit_events", { limit: 999 });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("limit=200");
  });
});

describe("dispatchTool: get_compliance_dossier (BUYER_JWT gated)", () => {
  it("happy path — from + to required", async () => {
    const f = mockFetchOk({
      success: true,
      dossier_metadata: { summary: { total_retrievals: 100 } },
    });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("get_compliance_dossier", {
      from: "2026-04-01",
      to: "2026-04-30",
    });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("from=2026-04-01");
    expect(call).toContain("to=2026-04-30");
    expect(call).toContain("format=json");
  });

  it("rejects missing from", async () => {
    mockFetchOk({});
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("get_compliance_dossier", { to: "2026-04-30" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("from");
  });
});

// ───────────────────────────── ACCESS_KEY-gated tools ─────────────────────────────

describe("dispatchTool: list_feed (ACCESS_KEY gated)", () => {
  it("happy path — sends access_key + format=json", async () => {
    const f = mockFetchOk({ success: true, data: { articles: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("list_feed", { limit: 50 });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("access_key=" + TEST_ACCESS_KEY);
    expect(call).toContain("format=json");
    expect(call).toContain("limit=50");
  });

  it("limit capped at 200", async () => {
    const f = mockFetchOk({ success: true, data: {} });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("list_feed", { limit: 5000 });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("limit=200");
  });
});

describe("dispatchTool: stream_feed_ndjson (ACCESS_KEY gated)", () => {
  it("parses NDJSON lines + extracts _meta", async () => {
    const f = mockFetchNdjson([
      { id: "art-1", title: "A" },
      { id: "art-2", title: "B" },
      { _meta: { count: 2, truncated: false } },
    ]);
    const { dispatchTool } = await loadDispatcher();
    const result = await dispatchTool("stream_feed_ndjson", {});
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("format=ndjson");
    const payload = JSON.parse(result.content[0].text) as {
      articles: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    expect(payload.articles.length).toBe(2);
    expect(payload.articles[0].id).toBe("art-1");
    expect(payload.meta.count).toBe(2);
  });

  it("limit capped at 1000", async () => {
    const f = mockFetchNdjson([{ _meta: {} }]);
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("stream_feed_ndjson", { limit: 99999 });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("limit=1000");
  });
});

// ───────────────────────────── API_KEY-gated tool ─────────────────────────────

describe("dispatchTool: list_publisher_content (PUB_BEARER preferred; API_KEY fallback)", () => {
  it("happy path — sends /api?action=articles + Authorization: Bearer canonical (v0.4.0)", async () => {
    const f = mockFetchOk({ success: true, data: { articles: [] } });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("list_publisher_content", { limit: 20 });
    const call = f.mock.calls[0];
    expect(String(call[0])).toContain("/api?action=articles");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    // v0.4.0: Bearer preferred when OPEDD_PUB_BEARER is set; X-API-Key
    // legacy fallback only when PUB_BEARER unset.
    expect(headers["Authorization"]).toBe("Bearer " + TEST_PUB_BEARER);
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("limit capped at 100", async () => {
    const f = mockFetchOk({ success: true, data: {} });
    const { dispatchTool } = await loadDispatcher();
    await dispatchTool("list_publisher_content", { limit: 999 });
    const call = String(f.mock.calls[0][0]);
    expect(call).toContain("limit=100");
  });
});
