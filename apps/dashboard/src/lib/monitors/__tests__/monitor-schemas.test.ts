import { describe, expect, it } from "vite-plus/test";
import {
  AssertionSchema,
  CreateMonitorSchema,
  HttpMonitorConfigSchema,
  HTTP_INTERVAL_PRESETS_V1,
  parseHttpMonitorConfig,
} from "@/lib/monitors/monitor-schemas";

/**
 * The monitor create/config schemas are the wire/storage contract. These pin
 * the type-discriminated create union (browser needs `source`, http needs
 * `config`), the per-source assertion validation table, the threshold/URL
 * refinements, and the stored-config parser.
 */

describe("CreateMonitorSchema — discriminated union", () => {
  it("accepts a browser monitor with a source", () => {
    const r = CreateMonitorSchema.safeParse({
      type: "browser",
      name: "Login",
      source: "test('x', async () => {});",
      intervalSeconds: 300,
      enabled: "on",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a browser monitor missing its source", () => {
    const r = CreateMonitorSchema.safeParse({
      type: "browser",
      name: "Login",
      intervalSeconds: 300,
    });
    expect(r.success).toBe(false);
  });

  it("accepts an http monitor with a minimal config", () => {
    const r = CreateMonitorSchema.safeParse({
      type: "http",
      name: "Homepage",
      intervalSeconds: 60,
      enabled: "on",
      config: { url: "https://example.com" },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "http") {
      // Defaults applied.
      expect(r.data.config.followRedirects).toBe(true);
      expect(r.data.config.maxResponseTimeMs).toBe(5000);
    }
  });

  it("rejects an http monitor with a private-network URL", () => {
    const r = CreateMonitorSchema.safeParse({
      type: "http",
      name: "Internal",
      intervalSeconds: 60,
      config: { url: "http://192.168.0.1" },
    });
    expect(r.success).toBe(false);
  });
});

describe("interval presets", () => {
  it("http accepts >=60s presets and rejects off-grid values", () => {
    const make = (intervalSeconds: number) =>
      CreateMonitorSchema.safeParse({
        type: "http",
        name: "x",
        intervalSeconds,
        config: { url: "https://example.com" },
      }).success;
    expect(make(60)).toBe(true);
    expect(make(86400)).toBe(true);
    expect(make(45)).toBe(false);
  });

  it("the v1 UI subset excludes sub-minute cadences", () => {
    expect(HTTP_INTERVAL_PRESETS_V1.every((s) => s >= 60)).toBe(true);
    expect(HTTP_INTERVAL_PRESETS_V1).not.toContain(10);
  });

  it("the schema still accepts sub-minute (data-compatible for the later phase)", () => {
    const r = CreateMonitorSchema.safeParse({
      type: "http",
      name: "x",
      intervalSeconds: 10,
      config: { url: "https://example.com" },
    });
    expect(r.success).toBe(true);
  });
});

describe("HttpMonitorConfigSchema — thresholds", () => {
  it("rejects a degraded threshold above the max", () => {
    const r = HttpMonitorConfigSchema.safeParse({
      url: "https://example.com",
      degradedResponseTimeMs: 6000,
      maxResponseTimeMs: 5000,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a zero degraded threshold (would mark every check degraded)", () => {
    const r = HttpMonitorConfigSchema.safeParse({
      url: "https://example.com",
      degradedResponseTimeMs: 0,
    });
    expect(r.success).toBe(false);
  });

  it("caps assertions at 10", () => {
    const r = HttpMonitorConfigSchema.safeParse({
      url: "https://example.com",
      assertions: Array.from({ length: 11 }, () => ({
        source: "STATUS_CODE",
        comparison: "EQUALS",
        target: "200",
      })),
    });
    expect(r.success).toBe(false);
  });
});

describe("AssertionSchema — per-source validation table", () => {
  const parse = (a: Record<string, unknown>) => AssertionSchema.safeParse(a);

  it("accepts a valid status-code assertion", () => {
    expect(
      parse({ source: "STATUS_CODE", comparison: "EQUALS", target: "200" })
        .success,
    ).toBe(true);
  });

  it("rejects a comparison not allowed for the source", () => {
    expect(
      parse({ source: "STATUS_CODE", comparison: "CONTAINS", target: "2" })
        .success,
    ).toBe(false);
  });

  it("requires a property for HEADERS and JSON_BODY", () => {
    expect(parse({ source: "HEADERS", comparison: "NOT_EMPTY" }).success).toBe(
      false,
    );
    expect(
      parse({
        source: "JSON_BODY",
        comparison: "EQUALS",
        target: "1",
      }).success,
    ).toBe(false);
    expect(
      parse({
        source: "HEADERS",
        property: "content-type",
        comparison: "NOT_EMPTY",
      }).success,
    ).toBe(true);
  });

  it("requires a numeric target for GREATER_THAN / LESS_THAN", () => {
    expect(
      parse({ source: "RESPONSE_TIME", comparison: "LESS_THAN", target: "abc" })
        .success,
    ).toBe(false);
    expect(
      parse({ source: "RESPONSE_TIME", comparison: "LESS_THAN", target: "500" })
        .success,
    ).toBe(true);
  });

  it("allows an empty target for IS_EMPTY / NOT_EMPTY", () => {
    expect(
      parse({
        source: "TEXT_BODY",
        comparison: "IS_EMPTY",
        target: "",
      }).success,
    ).toBe(true);
  });
});

describe("parseHttpMonitorConfig", () => {
  it("parses valid stored JSON", () => {
    const config = parseHttpMonitorConfig(
      JSON.stringify({ url: "https://example.com" }),
    );
    expect(config?.url).toBe("https://example.com");
  });

  it("returns null for null / malformed / invalid", () => {
    expect(parseHttpMonitorConfig(null)).toBe(null);
    expect(parseHttpMonitorConfig("{not json")).toBe(null);
    expect(parseHttpMonitorConfig(JSON.stringify({ url: "ftp://x" }))).toBe(
      null,
    );
  });
});
