// An agent without an Opedd account is told it can pay for one answer by card
// (POST /agent-answer, Machine Payments Protocol): in search_passages' tool
// description and in the no-key refusal, which is where an agent decides.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.stubEnv("OPEDD_BUYER_TOKEN", "");
  vi.stubEnv("OPEDD_ACCESS_KEY", "");
  vi.stubEnv("OPEDD_API_URL", "https://api.opedd.com");
});
afterEach(() => vi.restoreAllMocks());

async function load() {
  vi.resetModules();
  return await import("../src/index.ts");
}

describe("pay per answer without an account", () => {
  it("search_passages' description names the agent-answer door", async () => {
    const { ALL_TOOLS } = await load();
    const tool = ALL_TOOLS.find((t) => t.name === "search_passages");
    expect(tool?.description).toContain("POST https://api.opedd.com/agent-answer");
  });

  it("the no-key refusal offers it, and nothing is fetched", async () => {
    const f = vi.fn();
    globalThis.fetch = f as unknown as typeof fetch;
    const { dispatchTool } = await load();
    const out = JSON.stringify(await dispatchTool("search_passages", { query: "what moved chip export controls" }));
    expect(out).toContain("POST https://api.opedd.com/agent-answer");
    expect(out).toContain("opedd.com/buyer/signup");
    expect(f).not.toHaveBeenCalled();
  });
});
