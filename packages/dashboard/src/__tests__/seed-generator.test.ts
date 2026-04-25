// @ts-expect-error — .mjs import under scripts/ has no .d.ts; typed locally.
import { generateHistory } from "../../scripts/seed/generator.mjs";
import { describe, expect, it } from "vitest";

interface GeneratedRun {
  createdAt: number;
  completedAt: number;
  openPayload: {
    idempotencyKey: string;
    createdAt: number;
    run: {
      branch: string | null;
      plannedTests: Array<{ testId: string }>;
    };
  };
  resultsPayload: {
    results: Array<{
      testId: string;
      status: string;
      attempts: Array<{ attempt: number; status: string }>;
    }>;
  };
  completePayload: {
    status: string;
    durationMs: number;
    completedAt: number;
  };
}

interface Result {
  runs: GeneratedRun[];
  catalog: Array<{ stability: string }>;
  incidents: Array<{ testId: string }>;
}

describe("seed generator", () => {
  it("produces deterministic output for a fixed seed", () => {
    const a = generateHistory({
      seed: "t1",
      months: 1,
      now: 1_700_000_000,
    }) as Result;
    const b = generateHistory({
      seed: "t1",
      months: 1,
      now: 1_700_000_000,
    }) as Result;
    expect(a.runs.length).toBe(b.runs.length);
    expect(a.runs[0].openPayload.idempotencyKey).toBe(
      b.runs[0].openPayload.idempotencyKey,
    );
  });

  it("produces runs sorted by createdAt ascending", () => {
    const { runs } = generateHistory({
      seed: "t2",
      months: 1,
      now: 1_700_000_000,
    }) as Result;
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].createdAt).toBeGreaterThanOrEqual(runs[i - 1].createdAt);
    }
  });

  it("generates a realistic branch mix with main + PR branches", () => {
    const { runs } = generateHistory({
      seed: "t3",
      months: 2,
      now: 1_700_000_000,
    }) as Result;
    const branches = new Set(runs.map((r) => r.openPayload.run.branch));
    expect(branches.has("main")).toBe(true);
    expect(branches.size).toBeGreaterThan(5);
  });

  it("flaky test results have ≥2 attempts with at least one failure", () => {
    const { runs } = generateHistory({
      seed: "t4",
      months: 1,
      now: 1_700_000_000,
    }) as Result;
    const flakyResults = runs.flatMap((r) =>
      r.resultsPayload.results.filter((res) => res.status === "flaky"),
    );
    expect(flakyResults.length).toBeGreaterThan(0);
    for (const flaky of flakyResults) {
      expect(flaky.attempts.length).toBeGreaterThanOrEqual(2);
      expect(flaky.attempts.some((a) => a.status === "failed")).toBe(true);
      expect(flaky.attempts[flaky.attempts.length - 1].status).toBe("passed");
    }
  });

  it("every run has an open/results/complete triple with backdated timestamps", () => {
    const now = 1_700_000_000;
    const { runs } = generateHistory({ seed: "t5", months: 1, now }) as Result;
    for (const r of runs) {
      expect(r.openPayload.createdAt).toBeLessThan(now);
      expect(r.completePayload.completedAt).toBeGreaterThanOrEqual(
        r.openPayload.createdAt,
      );
      expect(r.resultsPayload.results.length).toBeGreaterThan(0);
    }
  });

  it("injects 2+ incident windows across 3 months", () => {
    const { incidents } = generateHistory({
      seed: "t6",
      months: 3,
      now: 1_700_000_000,
    }) as Result;
    expect(incidents.length).toBeGreaterThanOrEqual(2);
  });
});
