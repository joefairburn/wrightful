import { describe, it, expect } from "vitest";
import { generateIdempotencyKey } from "../lib/idempotency.js";

describe("generateIdempotencyKey", () => {
  it("returns ciBuildId when in CI", () => {
    expect(generateIdempotencyKey("12345")).toBe("12345");
  });

  it("generates a UUID when no CI build ID", () => {
    const key = generateIdempotencyKey(null);
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique UUIDs for local runs", () => {
    const a = generateIdempotencyKey(null);
    const b = generateIdempotencyKey(null);
    expect(a).not.toBe(b);
  });

  it("generates same key for same CI build (retry safe)", () => {
    const a = generateIdempotencyKey("build-1");
    const b = generateIdempotencyKey("build-1");
    expect(a).toBe(b);
  });
});
