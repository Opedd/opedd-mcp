// Anonymous usage telemetry for the Opedd MCP server.
//
// Captures ONLY which tool an agent called, how long it took, and whether it
// succeeded — NEVER parameters, responses, PII, keys, or content. This module
// is only ever handed the tool name + duration + ok flag, so there is nothing
// sensitive to leak by construction. It reports to Opedd's PostHog (EU region)
// so we can understand how AI agents use the MCP distribution channel.
//
// Opt out: set OPEDD_MCP_TELEMETRY=0 (or "false"/"off"), or the widely-used
// DO_NOT_TRACK=1. When opted out no client is created and nothing is sent.
//
// stdio-safe: PostHog is reached over HTTPS only; this module NEVER writes to
// stdout (that would corrupt the MCP JSON-RPC stream). All errors are swallowed
// so telemetry can never affect a tool call or the server.

import { PostHog } from "posthog-node";
import { randomUUID } from "node:crypto";

// Public, write-only PostHog project key (EU cloud, project 218295). Safe to
// embed — it can only send events, not read data.
const POSTHOG_KEY = "phc_yfyXBNsf5nZncZBiZNQBBs5RWC3mtWNWpUJv5EfzfBir";
const POSTHOG_HOST = "https://eu.i.posthog.com";
const SERVER_VERSION = "0.5.1";

/** Whether telemetry is allowed (respects OPEDD_MCP_TELEMETRY + DO_NOT_TRACK). Pure — exported for tests. */
export function isTelemetryEnabled(): boolean {
  const t = process.env.OPEDD_MCP_TELEMETRY?.toLowerCase();
  if (t === "0" || t === "false" || t === "off" || t === "no") return false;
  const dnt = process.env.DO_NOT_TRACK?.toLowerCase();
  if (dnt === "1" || dnt === "true") return false;
  return true;
}

/**
 * The ONLY properties ever sent for a tool call — no parameters, responses,
 * PII, keys, or content by construction. Pure; exported so a test can assert
 * the privacy invariant directly.
 */
export function toolCallProperties(
  tool: string,
  durationMs: number,
  ok: boolean,
): Record<string, string | number | boolean> {
  return {
    tool,
    duration_ms: Math.round(durationMs),
    ok,
    server_version: SERVER_VERSION,
  };
}

let client: PostHog | null = null;
// Anonymous per-process session id — not tied to any user, buyer, key, or IP.
const sessionId = randomUUID();

export function initTelemetry(): void {
  if (!isTelemetryEnabled()) return;
  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1, // low-volume telemetry; deliver each event promptly
      flushInterval: 30000,
    });
    // Swallow any transport error so it can never surface or crash the server.
    (client as unknown as { on?: (e: string, cb: () => void) => void }).on?.(
      "error",
      () => {},
    );
  } catch {
    client = null;
  }
}

export function captureToolCall(tool: string, durationMs: number, ok: boolean): void {
  if (!client) return;
  try {
    client.capture({
      distinctId: sessionId,
      event: "mcp_tool_call",
      properties: toolCallProperties(tool, durationMs, ok),
    });
  } catch {
    /* telemetry must never affect a tool call */
  }
}

export async function shutdownTelemetry(): Promise<void> {
  const c = client;
  client = null;
  if (!c) return;
  try {
    await c.shutdown();
  } catch {
    /* ignore */
  }
}
