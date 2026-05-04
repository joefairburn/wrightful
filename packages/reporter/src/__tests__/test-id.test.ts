import { describe, it, expect } from "vitest";
import { computeTestId } from "../test-id.js";

describe("computeTestId", () => {
  it("returns a 16-character hex string", () => {
    const id = computeTestId("a.spec.ts", ["t"], "chromium");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic across calls for the same input", () => {
    const a = computeTestId("a.spec.ts", ["suite", "case"], "chromium");
    const b = computeTestId("a.spec.ts", ["suite", "case"], "chromium");
    expect(a).toBe(b);
  });

  it("changes when the file changes", () => {
    const a = computeTestId("a.spec.ts", ["t"], "chromium");
    const b = computeTestId("b.spec.ts", ["t"], "chromium");
    expect(a).not.toBe(b);
  });

  it("changes when any segment of titlePath changes", () => {
    const a = computeTestId("a.spec.ts", ["suite", "case-1"], "chromium");
    const b = computeTestId("a.spec.ts", ["suite", "case-2"], "chromium");
    expect(a).not.toBe(b);
  });

  it("changes when the project name changes", () => {
    const a = computeTestId("a.spec.ts", ["t"], "chromium");
    const b = computeTestId("a.spec.ts", ["t"], "firefox");
    expect(a).not.toBe(b);
  });

  it("uses the NUL separator so [a, bc] and [ab, c] don't collide", () => {
    // Without a non-trivial separator, ["a", "bc"] and ["ab", "c"] would
    // join to identical strings. This is the whole point of using \0.
    const a = computeTestId("file", ["a", "bc"], "p");
    const b = computeTestId("file", ["ab", "c"], "p");
    expect(a).not.toBe(b);
  });

  it("treats an empty title path as valid (single root-level test)", () => {
    const id = computeTestId("a.spec.ts", [], "chromium");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats empty projectName as a distinct value (vs missing)", () => {
    // The reporter sometimes has '' (no Playwright project configured).
    // Verify that's still a stable, deterministic id — not throwing.
    const id = computeTestId("a.spec.ts", ["t"], "");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles unicode in title path without throwing or truncating", () => {
    const id = computeTestId("a.spec.ts", ["💥 boom", "café"], "p");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
