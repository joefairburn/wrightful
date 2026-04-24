import { sql } from "kysely";
import { Clock, Gauge, TriangleAlert } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { AnalyticsButtonGroup } from "@/app/components/analytics/button-group";
import { InsightsTabs } from "@/app/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/app/components/analytics/kpi-card";
import {
  AnalyticsLineChart,
  type LineChartBucket,
  type LineChartSeries,
} from "@/app/components/analytics/line-chart";
import { Card, CardPanel } from "@/app/components/ui/card";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import {
  bucketExpr,
  bucketKey,
  buildEmptyBuckets,
  DAY_SEC,
  parseSegment,
  type Segment,
  SEGMENTS,
} from "@/lib/analytics/bucketing";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";
import { formatDuration } from "@/lib/time-format";

type RangeKey = "7d" | "14d" | "30d" | "90d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d", "90d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "30d");

function defaultSegmentForRange(range: RangeKey): Segment {
  return range === "90d" ? "week" : "day";
}

/**
 * Percentile colours — mirror the prototype's "cooler as more extreme":
 * p50 uses the muted foreground, p90 the amber/flaky tone, p95 the red
 * error tone so regressions at the tail read at a glance.
 */
const SERIES_COLORS = {
  p50: "var(--color-foreground)",
  p90: "#ea580c",
  p95: "#dc2626",
} as const;

export async function RunDurationPage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const range = parseRange(url.searchParams.get("range"));
  const segment = parseSegment(
    url.searchParams.get("segment"),
    defaultSegmentForRange(range),
  );
  const rangeSec = rangeToSeconds(range);
  const days = rangeSec ? rangeSec / DAY_SEC : 30;

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - days * DAY_SEC;

  // SQL-side discrete percentile picking. For each bucket we rank runs by
  // duration (`row_number()` window) and select the row whose rank equals
  // the p-th position. Returns ≤ 3·N rows where N = bucket count, so the
  // DO payload is O(buckets), not O(runs).
  //
  // `MAX(1, CAST(ROUND(cnt * q) AS INTEGER))` keeps the target rank in
  // [1..cnt] — without the floor of 1 a bucket with a single run would
  // resolve p50 to rank 0 (no such row).
  //
  // Discrete percentiles (no interpolation): fine at the bar-chart
  // resolution we render here, and much simpler than emulating R-7
  // inside SQLite.
  const expr = bucketExpr(segment);
  const [perBucket, overall] = await Promise.all([
    sql<{
      bucket: number | string;
      cnt: number;
      p50: number | null;
      p90: number | null;
      p95: number | null;
    }>`
      WITH ranked AS (
        SELECT
          ${expr} AS bucket,
          runs."durationMs" AS duration,
          row_number() OVER (
            PARTITION BY ${expr}
            ORDER BY runs."durationMs"
          ) AS rn,
          count(*) OVER (PARTITION BY ${expr}) AS cnt
        FROM runs
        WHERE runs."projectId" = ${project.id}
          AND runs."committed" = 1
          AND runs."durationMs" > 0
          AND runs."createdAt" >= ${windowStartSec}
      )
      SELECT
        bucket,
        MAX(cnt) AS cnt,
        MIN(CASE WHEN rn = MAX(1, CAST(ROUND(cnt * 0.50) AS INTEGER)) THEN duration END) AS p50,
        MIN(CASE WHEN rn = MAX(1, CAST(ROUND(cnt * 0.90) AS INTEGER)) THEN duration END) AS p90,
        MIN(CASE WHEN rn = MAX(1, CAST(ROUND(cnt * 0.95) AS INTEGER)) THEN duration END) AS p95
      FROM ranked
      GROUP BY bucket
    `.execute(project.db),
    sql<{
      cnt: number | null;
      p50: number | null;
      p90: number | null;
      p95: number | null;
    }>`
      WITH ranked AS (
        SELECT
          runs."durationMs" AS duration,
          row_number() OVER (ORDER BY runs."durationMs") AS rn,
          count(*) OVER () AS cnt
        FROM runs
        WHERE runs."projectId" = ${project.id}
          AND runs."committed" = 1
          AND runs."durationMs" > 0
          AND runs."createdAt" >= ${windowStartSec}
      )
      SELECT
        MAX(cnt) AS cnt,
        MIN(CASE WHEN rn = MAX(1, CAST(ROUND(cnt * 0.50) AS INTEGER)) THEN duration END) AS p50,
        MIN(CASE WHEN rn = MAX(1, CAST(ROUND(cnt * 0.90) AS INTEGER)) THEN duration END) AS p90,
        MIN(CASE WHEN rn = MAX(1, CAST(ROUND(cnt * 0.95) AS INTEGER)) THEN duration END) AS p95
      FROM ranked
    `.execute(project.db),
  ]);

  const shells = buildEmptyBuckets(segment, windowStartSec, nowSec);
  const series: LineChartSeries[] = [
    { key: "p50", label: "p50", color: SERIES_COLORS.p50 },
    { key: "p90", label: "p90", color: SERIES_COLORS.p90 },
    { key: "p95", label: "p95", color: SERIES_COLORS.p95 },
  ];

  const byKey = new Map(perBucket.rows.map((r) => [bucketKey(r.bucket), r]));
  const buckets: LineChartBucket[] = shells.map((s) => {
    const row = byKey.get(s.key);
    const p50 = row?.p50 ?? null;
    const p90 = row?.p90 ?? null;
    const p95 = row?.p95 ?? null;
    const cnt = row?.cnt ?? 0;
    return {
      key: s.key,
      label: s.label,
      values: [p50, p90, p95],
      tooltip: (
        <>
          <div className="mb-2 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label} · {cnt} run{cnt === 1 ? "" : "s"}
          </div>
          {cnt === 0 ? (
            <div className="font-mono text-[11px] text-muted-foreground">
              No runs
            </div>
          ) : (
            <div className="space-y-1 font-mono text-[11px]">
              <PercentileRow
                label="p50"
                value={p50}
                color={SERIES_COLORS.p50}
              />
              <PercentileRow
                label="p90"
                value={p90}
                color={SERIES_COLORS.p90}
              />
              <PercentileRow
                label="p95"
                value={p95}
                color={SERIES_COLORS.p95}
              />
            </div>
          )}
        </>
      ),
    };
  });

  // The overall CTE has no GROUP BY, so an empty window still yields
  // one row — but with NULLs for every aggregate. Coerce `cnt` to 0 so
  // the KPI footnote logic below can treat "no runs" uniformly.
  const overallStats = overall.rows[0] ?? {
    cnt: 0,
    p50: null,
    p90: null,
    p95: null,
  };
  const overallCnt = overallStats.cnt ?? 0;
  const { p50: p50All, p90: p90All, p95: p95All } = overallStats;

  const hrefWith = (overrides: Record<string, string>): string => {
    const p = new URLSearchParams(url.searchParams);
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    return `${url.pathname}?${p.toString()}`;
  };

  return (
    <>
      <InsightsTabs
        teamSlug={project.teamSlug}
        projectSlug={project.slug}
        active="run-duration"
      />

      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Run Duration Trends
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wider">
            Pipeline execution percentiles · Last {days} days
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsButtonGroup
            options={SEGMENTS}
            value={segment}
            hrefFor={(s) => hrefWith({ segment: s })}
          />
          <AnalyticsButtonGroup
            options={RANGES}
            value={range}
            hrefFor={(r) => hrefWith({ range: r })}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <AnalyticsKpiCard
            label="Median Duration (p50)"
            value={formatOrDash(p50All)}
            Icon={Clock}
            iconColor={SERIES_COLORS.p50}
            footnote={
              overallCnt === 0
                ? "No runs in window"
                : `Across ${overallCnt.toLocaleString()} runs`
            }
          />
          <AnalyticsKpiCard
            label="P90 Threshold"
            value={formatOrDash(p90All)}
            Icon={Gauge}
            iconColor={SERIES_COLORS.p90}
          />
          <AnalyticsKpiCard
            label="P95 Wall-Clock Time"
            value={formatOrDash(p95All)}
            Icon={TriangleAlert}
            iconColor={SERIES_COLORS.p95}
          />
        </div>

        <Card>
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div>
              <h2 className="text-base font-semibold">Duration Percentiles</h2>
              <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                Per {segment} — p50, p90, p95 of `runs.durationMs`
              </p>
            </div>
            <Legend series={series} />
          </div>
          <CardPanel className="pt-0">
            <AnalyticsLineChart
              buckets={buckets}
              series={series}
              height={360}
              formatYTick={(ms) => formatDuration(Math.round(ms))}
              ariaLabel={`Duration percentiles across ${buckets.length} buckets`}
              emptyState="No runs in this window."
            />
          </CardPanel>
        </Card>
      </div>
    </>
  );
}

// ---- helpers ---------------------------------------------------------

function formatOrDash(ms: number | null): string {
  return ms === null ? "—" : formatDuration(Math.round(ms));
}

function PercentileRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number | null;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        <span className="text-foreground">{label}</span>
      </span>
      <span className="text-foreground">{formatOrDash(value)}</span>
    </div>
  );
}

function Legend({ series }: { series: LineChartSeries[] }) {
  return (
    <div className="hidden sm:flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
      {series.map((s) => (
        <div key={s.key} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3"
            style={{ background: s.color }}
          />
          {s.label}
        </div>
      ))}
    </div>
  );
}
