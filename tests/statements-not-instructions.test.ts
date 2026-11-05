// Model-readable text states facts, never instructs the model (2026-11-05).
// Anthropic's connector directory requires tool descriptions with "no
// instructions about model behavior, other tools, or external instruction
// sources"; OpenAI's app guidelines forbid steering the model to prefer one
// tool. Other tools may be named as facts ("get_content returns article
// text"), never as orders ("use get_content").
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, SERVER_INSTRUCTIONS } from "../src/index.js";

const ORDERS = /\b(call (this|it)|use (it|this)\b|use [a-z]+_[a-z_]+|do not interpret|always call|never call|before answering|prefer\b|instead of|should use|treat as)\b/i;

describe("model-readable text", () => {
  it("tool and parameter descriptions are statements", () => {
    for (const t of ALL_TOOLS) {
      const props = Object.values((t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {});
      for (const text of [t.description ?? "", ...props.map((p) => p.description ?? "")]) {
        expect(text, t.name).not.toMatch(ORDERS);
      }
    }
  });
  it("the server instructions are statements", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(ORDERS);
  });
});
