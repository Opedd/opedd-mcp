import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTelemetryEnabled, toolCallProperties } from "../src/telemetry.ts";

const ORIG_ENV = { ...process.env };

describe("telemetry — opt-out", () => {
  beforeEach(() => {
    delete process.env.OPEDD_MCP_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("enabled by default", () => {
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("OPEDD_MCP_TELEMETRY=0 / false / off disable it", () => {
    for (const v of ["0", "false", "off", "no"]) {
      process.env.OPEDD_MCP_TELEMETRY = v;
      expect(isTelemetryEnabled()).toBe(false);
    }
  });

  it("DO_NOT_TRACK=1 disables it", () => {
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("telemetry — privacy invariant", () => {
  it("captures ONLY the four safe fields; never params, PII, or credentials", () => {
    const props = toolCallProperties("lookup_content", 42.7, true);
    expect(Object.keys(props).sort()).toEqual([
      "duration_ms",
      "ok",
      "server_version",
      "tool",
    ]);
    expect(props.tool).toBe("lookup_content");
    expect(props.duration_ms).toBe(43); // rounded
    expect(props.ok).toBe(true);
    // Hard guarantee: no parameter / response / content / credential keys.
    const keys = Object.keys(props).join(",");
    expect(keys).not.toMatch(
      /param|input|arg|response|result|content|email|key|token|url|body/i,
    );
  });
});
