import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({ getControlDb: vi.fn() }));
vi.mock("@/tenant", () => ({ tenantScopeForApiKey: vi.fn() }));

import { buildChangedTests } from "../routes/api/runs";
import type { TestResultInput } from "../routes/api/schemas";

function input(overrides: Partial<TestResultInput>): TestResultInput {
  return {
    testId: "t-1",
    title: "test 1",
    file: "spec.ts",
    status: "passed",
    durationMs: 100,
    retryCount: 0,
    tags: [],
    annotations: [],
    attempts: [
      {
        attempt: 0,
        status: "passed",
        durationMs: 100,
        errorMessage: null,
        errorStack: null,
      },
    ],
    ...overrides,
  };
}

describe("buildChangedTests", () => {
  it("maps each result to its assigned testResultId", () => {
    const results = [input({ testId: "t-1" }), input({ testId: "t-2" })];
    const ids = new Map([
      ["t-1", "tr-aaa"],
      ["t-2", "tr-bbb"],
    ]);
    const out = buildChangedTests(results, ids);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("tr-aaa");
    expect(out[1].id).toBe("tr-bbb");
  });

  it("passes through testId, title, file, status, durationMs, retryCount", () => {
    const out = buildChangedTests(
      [
        input({
          testId: "t-1",
          title: "my test",
          file: "a/b.spec.ts",
          status: "failed",
          durationMs: 1234,
          retryCount: 2,
        }),
      ],
      new Map([["t-1", "tr-1"]]),
    );
    expect(out[0]).toMatchObject({
      testId: "t-1",
      title: "my test",
      file: "a/b.spec.ts",
      status: "failed",
      durationMs: 1234,
      retryCount: 2,
    });
  });

  it("normalises absent projectName/errorMessage/errorStack to null (not undefined)", () => {
    const out = buildChangedTests([input({})], new Map([["t-1", "tr-1"]]));
    expect(out[0].projectName).toBeNull();
    expect(out[0].errorMessage).toBeNull();
    expect(out[0].errorStack).toBeNull();
  });

  it("preserves non-null projectName / error fields", () => {
    const out = buildChangedTests(
      [
        input({
          projectName: "chromium",
          errorMessage: "boom",
          errorStack: "Error: boom\n    at …",
        }),
      ],
      new Map([["t-1", "tr-1"]]),
    );
    expect(out[0].projectName).toBe("chromium");
    expect(out[0].errorMessage).toBe("boom");
    expect(out[0].errorStack).toContain("at");
  });

  it("returns an empty array for an empty batch (no DB lookup)", () => {
    expect(buildChangedTests([], new Map())).toEqual([]);
  });

  it("preserves order of input results", () => {
    const results = [
      input({ testId: "t-1" }),
      input({ testId: "t-2" }),
      input({ testId: "t-3" }),
    ];
    const ids = new Map([
      ["t-1", "tr-1"],
      ["t-2", "tr-2"],
      ["t-3", "tr-3"],
    ]);
    expect(buildChangedTests(results, ids).map((r) => r.testId)).toEqual([
      "t-1",
      "t-2",
      "t-3",
    ]);
  });
});
