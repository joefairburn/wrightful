import { describe, expect, it } from "vite-plus/test";
import { rate } from "@/lib/rate";
import {
  type OutcomeAggRow,
  summarizeInsightsKpis,
} from "../../pages/t/[teamSlug]/p/[projectSlug]/insights/index.server";
import { summarizeFailureKpis } from "../../pages/t/[teamSlug]/p/[projectSlug]/failures.server";
import {
  type RankedTest,
  summarizeFlakyKpis,
} from "../../pages/t/[teamSlug]/p/[projectSlug]/flaky.server";
import {
  summarizeSuiteSizeKpis,
  type TrendRow,
} from "../../pages/t/[teamSlug]/p/[projectSlug]/insights/suite-size.server";
import { DAY_SEC } from "@/lib/analytics/bucketing";

/**
 * The analytics KPI/rate math used to live in the React page bodies, where it
 * was structurally untestable (a render with no DOM assertion). It now lives in
 * the loaders as pure summarizers over the aggregate rows, with the shared
 * divide-by-zero policy owned by `rate()`. These tests pin that math directly —
 * before this move ZERO tests referenced passRate / flakyRate / avgFlakeRate.
 *
 * Behaviour-preservation is the bar: the numbers here must match what the pages
 * rendered before the relocation (the underlying coercion bugs were already
 * fixed separately; this only moved the assembly).
 */

describe("rate()", () => {
  it("returns a 0..100 percentage", () => {
    expect(rate(1, 4)).toBe(25);
    expect(rate(3, 4)).toBe(75);
    expect(rate(4, 4)).toBe(100);
  });

  it("returns 0 for a non-positive denominator instead of NaN/Infinity", () => {
    expect(rate(0, 0)).toBe(0);
    expect(rate(5, 0)).toBe(0);
    expect(rate(5, -2)).toBe(0);
  });

  it("returns 0 for a zero numerator over a real denominator", () => {
    expect(rate(0, 10)).toBe(0);
  });
});

function agg(partial: Partial<OutcomeAggRow>): OutcomeAggRow {
  return {
    bucket: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    runs: 0,
    ...partial,
  };
}

describe("summarizeInsightsKpis", () => {
  it("sums per-bucket counts and derives the KPI rates", () => {
    const rows: OutcomeAggRow[] = [
      agg({ passed: 80, failed: 10, flaky: 10, skipped: 5, runs: 6 }),
      agg({ passed: 10, failed: 0, flaky: 0, skipped: 0, runs: 4 }),
    ];
    const k = summarizeInsightsKpis(rows, 5);
    // totals
    expect(k.totalPassed).toBe(90);
    expect(k.totalFailed).toBe(10);
    expect(k.totalFlaky).toBe(10);
    expect(k.totalRuns).toBe(10);
    // executed = passed + failed + flaky (skipped excluded), so 110
    expect(k.executed).toBe(110);
    // pass rate over executions, flake rate over executions
    expect(k.passRate).toBeCloseTo((90 / 110) * 100, 10);
    expect(k.flakyRate).toBeCloseTo((10 / 110) * 100, 10);
    // avg runs over the window length (days), NOT over the bucket count
    expect(k.avgRunsPerDay).toBe(2);
  });

  it("yields zeroed rates for an empty window (no executions)", () => {
    const k = summarizeInsightsKpis([], 30);
    expect(k.executed).toBe(0);
    expect(k.passRate).toBe(0);
    expect(k.flakyRate).toBe(0);
    expect(k.avgRunsPerDay).toBe(0);
  });

  it("guards avgRunsPerDay against a non-positive window length", () => {
    const rows = [agg({ runs: 3 })];
    expect(summarizeInsightsKpis(rows, 0).avgRunsPerDay).toBe(0);
  });
});

function ranked(pct: number, flakyCount: number): RankedTest {
  return {
    testId: `t-${pct}-${flakyCount}`,
    total: flakyCount,
    flakyCount,
    passedCount: 0,
    pct,
  };
}

describe("summarizeFlakyKpis", () => {
  it("totals failures and averages the per-test flake rate over the shown slice", () => {
    const slice = [ranked(100, 3), ranked(50, 1), ranked(0, 0)];
    const k = summarizeFlakyKpis(slice);
    // total failures = sum of per-test flakyCount
    expect(k.totalFailures).toBe(4);
    // avg flake rate = mean of the per-test pct values (already 0..100)
    expect(k.avgFlakeRate).toBeCloseTo((100 + 50 + 0) / 3, 10);
  });

  it("returns zeroed KPIs for an empty slice", () => {
    const k = summarizeFlakyKpis([]);
    expect(k.totalFailures).toBe(0);
    expect(k.avgFlakeRate).toBe(0);
  });
});

describe("summarizeFailureKpis", () => {
  const windowStartSec = 1_000_000;
  const agg = (signature: string, occurrenceCount: number, testCount = 1) => ({
    signature,
    occurrenceCount,
    testCount,
    lastSeenAt: windowStartSec + 100,
  });

  it("counts occurrences over ALL window signatures and news by first-seen", () => {
    const aggregates = [agg("sig_known", 5), agg("sig_new", 2)];
    const firstSeen = new Map([
      ["sig_known", windowStartSec - 10], // predates the window → known
      ["sig_new", windowStartSec + 50], // first seen inside → new
    ]);
    const k = summarizeFailureKpis(aggregates, firstSeen, windowStartSec);
    expect(k.distinctSignatures).toBe(2);
    expect(k.totalOccurrences).toBe(7);
    expect(k.newSignatures).toBe(1);
  });

  it("treats a signature with no first-seen row as not-new and zeroes an empty window", () => {
    const k = summarizeFailureKpis(
      [agg("sig_orphan", 1)],
      new Map(),
      windowStartSec,
    );
    expect(k.newSignatures).toBe(0);
    const empty = summarizeFailureKpis([], new Map(), windowStartSec);
    expect(empty).toEqual({
      distinctSignatures: 0,
      totalOccurrences: 0,
      newSignatures: 0,
    });
  });
});

describe("summarizeSuiteSizeKpis", () => {
  // A 5-day window. Day buckets are floor(sec / DAY_SEC); pick a start/end
  // spanning days N..N+4 so the skeleton has 5 slots.
  const startDay = 20_000;
  const windowStartSec = startDay * DAY_SEC;
  const nowSec = (startDay + 4) * DAY_SEC;

  function trend(dayOffset: number, peak: number): TrendRow {
    // bucketExpr produces floor(createdAt / DAY_SEC) as the bucket key.
    return { bucket: startDay + dayOffset, peak };
  }

  it("derives the peak series + net change / growth from the populated buckets", () => {
    // Buckets at offsets 0, 2, 4 populated; 1 and 3 empty (dropped).
    const rows: TrendRow[] = [trend(0, 100), trend(2, 120), trend(4, 150)];
    const k = summarizeSuiteSizeKpis("day", windowStartSec, nowSec, rows);
    // Populated buckets only, in bucket order.
    expect(k.peakSpark).toEqual([100, 120, 150]);
    expect(k.firstPeak).toBe(100);
    expect(k.lastPeak).toBe(150);
    expect(k.netChange).toBe(50);
    expect(k.growthPct).toBeCloseTo((50 / 100) * 100, 10);
  });

  it("handles a single populated bucket (no growth)", () => {
    const rows: TrendRow[] = [trend(2, 80)];
    const k = summarizeSuiteSizeKpis("day", windowStartSec, nowSec, rows);
    expect(k.peakSpark).toEqual([80]);
    expect(k.firstPeak).toBe(80);
    // lastPeak falls back to firstPeak when there is one sample.
    expect(k.lastPeak).toBe(80);
    expect(k.netChange).toBe(0);
    expect(k.growthPct).toBe(0);
  });

  it("zeroes everything for an empty window (no trend rows)", () => {
    const k = summarizeSuiteSizeKpis("day", windowStartSec, nowSec, []);
    expect(k.peakSpark).toEqual([]);
    expect(k.firstPeak).toBe(0);
    expect(k.lastPeak).toBe(0);
    expect(k.netChange).toBe(0);
    // growth guards against the zero first-peak denominator via rate().
    expect(k.growthPct).toBe(0);
  });

  it("reports a negative net change when the suite shrinks", () => {
    const rows: TrendRow[] = [trend(0, 200), trend(4, 150)];
    const k = summarizeSuiteSizeKpis("day", windowStartSec, nowSec, rows);
    expect(k.peakSpark).toEqual([200, 150]);
    expect(k.netChange).toBe(-50);
    expect(k.growthPct).toBeCloseTo((-50 / 200) * 100, 10);
  });
});
