// 0.12.0 — what an enterprise agent needs from the tool list (MCP
// enterprise readiness, 2026-10-14):
//   - every tool carries a title and behaviour hints (directories require
//     readOnlyHint/destructiveHint; agents use them to decide what may run
//     unattended), and nothing that spends money is marked read-only;
//   - search_passages forwards its filters untouched (the API owns the rules);
//   - ONE buyer key reaches the feed: with only OPEDD_BUYER_TOKEN set, the feed
//     tools register and authenticate with it plus order_id.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const BUYER_KEY = "opedd_buyer_live_enterprise_ready_xxx";

beforeAll(() => {
  vi.stubEnv("OPEDD_BUYER_TOKEN", BUYER_KEY);
  vi.stubEnv("OPEDD_ACCESS_KEY", "");
  vi.stubEnv("OPEDD_API_URL", "https://api.opedd.com");
});
afterEach(() => vi.restoreAllMocks());

async function load() {
  vi.resetModules();
  return await import("../src/index.ts");
}
function mockFetchOk(body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("tool annotations", () => {
  it("every advertised tool has a title and both directory hints", async () => {
    const { ALL_TOOLS } = await load();
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(20);
    for (const t of ALL_TOOLS) {
      expect(t.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, t.name).toBe("boolean");
      expect(t.annotations?.title, t.name).toBe(t.title);
    }
  });

  it("nothing that spends money or creates an order is read-only", async () => {
    const { ALL_TOOLS } = await load();
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    for (const name of ["search_passages", "place_licence_order", "push_content"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(byName.get("push_content")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("get_content")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("search_passages filters", () => {
  it("forwards publishers, the date window, max_results and max_charge_cents untouched", async () => {
    const f = mockFetchOk({ success: true, data: { passages: [] } });
    const { dispatchTool } = await load();
    await dispatchTool("search_passages", {
      query: "what moved chip export controls",
      publishers: ["11111111-1111-4111-8111-111111111111"],
      published_after: "2026-01-01",
      published_before: "2026-07-01",
      max_results: 10,
      max_charge_cents: 30,
    });
    const init = f.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      query: "what moved chip export controls",
      publishers: ["11111111-1111-4111-8111-111111111111"],
      published_after: "2026-01-01",
      published_before: "2026-07-01",
      max_results: 10,
      max_charge_cents: 30,
    });
  });

  it("sends only the query when no filter is given (unchanged wire)", async () => {
    const f = mockFetchOk({ success: true, data: { passages: [] } });
    const { dispatchTool } = await load();
    await dispatchTool("search_passages", { query: "a question" });
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ query: "a question" });
  });
});

describe("one buyer key reaches the feed", () => {
  it("feed tools register with only a buyer key", async () => {
    const { TOOLS } = await load();
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_feed");
    expect(names).toContain("stream_feed_ndjson");
  });

  it("list_feed authenticates with the buyer key and passes order_id; no key in the URL", async () => {
    const f = mockFetchOk({ success: true, data: { articles: [] } });
    const { dispatchTool } = await load();
    await dispatchTool("list_feed", { order_id: "33333333-3333-4333-8333-333333333333", limit: 10 });
    const url = String(f.mock.calls[0][0]);
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${BUYER_KEY}`);
    expect(headers["X-Enterprise-Key"]).toBeUndefined();
    expect(url).toContain("order_id=33333333-3333-4333-8333-333333333333");
    expect(url).not.toContain(BUYER_KEY);
  });

  it("without order_id it lets the API pick the single order (or list them)", async () => {
    const f = mockFetchOk({ success: true, data: { articles: [] } });
    const { dispatchTool } = await load();
    await dispatchTool("list_feed", {});
    expect(String(f.mock.calls[0][0])).not.toContain("order_id=");
  });
});
