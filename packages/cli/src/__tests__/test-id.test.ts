import { describe, it, expect } from "vitest";
import { computeTestId } from "../lib/test-id.js";

describe("computeTestId", () => {
  it("produces a 16-character hex string", () => {
    const id = computeTestId(
      "tests/foo.spec.ts",
      ["describe", "test"],
      "chromium",
    );
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — same inputs produce same ID", () => {
    const a = computeTestId("tests/foo.spec.ts", ["A", "B"], "chromium");
    const b = computeTestId("tests/foo.spec.ts", ["A", "B"], "chromium");
    expect(a).toBe(b);
  });

  it("different files produce different IDs", () => {
    const a = computeTestId("tests/foo.spec.ts", ["test"], "chromium");
    const b = computeTestId("tests/bar.spec.ts", ["test"], "chromium");
    expect(a).not.toBe(b);
  });

  it("different title paths produce different IDs", () => {
    const a = computeTestId("tests/foo.spec.ts", ["A", "B"], "chromium");
    const b = computeTestId("tests/foo.spec.ts", ["A", "C"], "chromium");
    expect(a).not.toBe(b);
  });

  it("different projects produce different IDs", () => {
    const a = computeTestId("tests/foo.spec.ts", ["test"], "chromium");
    const b = computeTestId("tests/foo.spec.ts", ["test"], "firefox");
    expect(a).not.toBe(b);
  });

  it("null byte separator prevents title path collisions", () => {
    // ["a", "bc"] vs ["ab", "c"] should differ
    const a = computeTestId("f", ["a", "bc"], "p");
    const b = computeTestId("f", ["ab", "c"], "p");
    expect(a).not.toBe(b);
  });

  it("handles empty title path", () => {
    const id = computeTestId("tests/foo.spec.ts", [], "chromium");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles empty project name", () => {
    const id = computeTestId("tests/foo.spec.ts", ["test"], "");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
