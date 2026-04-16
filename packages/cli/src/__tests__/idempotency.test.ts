import { describe, it, expect } from "vitest";
import { generateIdempotencyKey } from "../lib/idempotency.js";

describe("generateIdempotencyKey", () => {
  it("generates {buildId}-{shardIndex} when in CI", () => {
    expect(generateIdempotencyKey("12345", 2)).toBe("12345-2");
  });

  it("defaults shard index to 0 when null", () => {
    expect(generateIdempotencyKey("12345", null)).toBe("12345-0");
  });

  it("defaults shard index to 0 when undefined", () => {
    expect(generateIdempotencyKey("12345", undefined)).toBe("12345-0");
  });

  it("generates a UUID when no CI build ID", () => {
    const key = generateIdempotencyKey(null, null);
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique UUIDs for local runs", () => {
    const a = generateIdempotencyKey(null, null);
    const b = generateIdempotencyKey(null, null);
    expect(a).not.toBe(b);
  });

  it("generates same key for same CI build + shard (retry safe)", () => {
    const a = generateIdempotencyKey("build-1", 0);
    const b = generateIdempotencyKey("build-1", 0);
    expect(a).toBe(b);
  });
});
