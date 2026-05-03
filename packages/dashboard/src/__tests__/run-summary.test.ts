import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  buildRunSummary,
  composeRunSummaryBatch,
  type RunRowForSummary,
} from "../routes/api/progress";

function row(overrides: Partial<RunRowForSummary>): RunRowForSummary {
  return {
    id: "run-1",
    status: "running",
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    totalTests: 0,
    expectedTotalTests: null,
    ...overrides,
  };
}

describe("buildRunSummary", () => {
  it("derives totalDone from the bucket sum", () => {
    const s = buildRunSummary(
      row({ passed: 3, failed: 2, flaky: 1, skipped: 4, totalTests: 20 }),
    );
    expect(s.totalDone).toBe(10);
  });

  it("derives queued as totalTests - completed buckets", () => {
    const s = buildRunSummary(
      row({ passed: 3, failed: 2, flaky: 1, skipped: 4, totalTests: 20 }),
    );
    expect(s.counts.queued).toBe(10);
  });

  it("clamps queued to 0 when totalTests is somehow less than completed", () => {
    // Defensive: if a delta UPDATE drifts from the test-results count, the
    // summary should never report negative queued.
    const s = buildRunSummary(row({ passed: 5, totalTests: 3 }));
    expect(s.counts.queued).toBe(0);
  });

  it("passes through expectedTotalTests as expectedTotal", () => {
    expect(buildRunSummary(row({ expectedTotalTests: 42 })).expectedTotal).toBe(
      42,
    );
    expect(
      buildRunSummary(row({ expectedTotalTests: null })).expectedTotal,
    ).toBeNull();
  });

  it("passes through totalTests on the summary", () => {
    expect(buildRunSummary(row({ totalTests: 17 })).totalTests).toBe(17);
  });

  it("normalises an unknown run status to 'running'", () => {
    expect(buildRunSummary(row({ status: "garbage" })).status).toBe("running");
  });

  it("preserves valid run statuses", () => {
    for (const status of [
      "running",
      "passed",
      "failed",
      "flaky",
      "timedout",
      "interrupted",
    ] as const) {
      expect(buildRunSummary(row({ status })).status).toBe(status);
    }
  });

  it("does not include a tests array (split into RunTestsTail)", () => {
    const s = buildRunSummary(row({}));
    expect((s as unknown as { tests?: unknown }).tests).toBeUndefined();
  });

  it("stamps updatedAt with a recent timestamp", () => {
    const before = Date.now();
    const s = buildRunSummary(row({}));
    const after = Date.now();
    expect(s.updatedAt).toBeGreaterThanOrEqual(before);
    expect(s.updatedAt).toBeLessThanOrEqual(after);
  });
});

describe("composeRunSummaryBatch", () => {
  it("returns a map keyed by run id", () => {
    const map = composeRunSummaryBatch([
      row({ id: "a", passed: 1, totalTests: 5 }),
      row({ id: "b", failed: 2, totalTests: 3 }),
    ]);
    expect(map.size).toBe(2);
    expect(map.get("a")?.counts.passed).toBe(1);
    expect(map.get("b")?.counts.failed).toBe(2);
  });

  it("returns an empty map for an empty input (and does not touch the DB)", () => {
    expect(composeRunSummaryBatch([]).size).toBe(0);
  });
});
