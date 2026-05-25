import { Clock, Gauge, TriangleAlert } from "lucide-react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import {
  AnalyticsLineChart,
  type LineChartBucket,
  type LineChartSeries,
} from "@/components/analytics/line-chart";
import { Card, CardPanel } from "@/components/ui/card";
import { bucketKey, buildEmptyBuckets } from "@/lib/analytics/bucketing";
import { formatDuration } from "@/lib/time-format";
import type { Props } from "./run-duration.server";

const SERIES_COLORS = {
  p50: "var(--color-foreground)",
  p90: "#ea580c",
  p95: "#dc2626",
} as const;

/**
 * Run Duration analytics page. Multi-series line chart of p50/p90/p95
 * durations per bucket plus the overall percentile KPI cards.
 */
export default function RunDurationPage({
  project,
  range,
  segment,
  days,
  nowSec,
  windowStartSec,
  perBucket,
  overall,
  pathname,
  segments,
  ranges,
}: Props) {
  const shells = buildEmptyBuckets(segment, windowStartSec, nowSec);
  const series: LineChartSeries[] = [
    { key: "p50", label: "p50", color: SERIES_COLORS.p50 },
    { key: "p90", label: "p90", color: SERIES_COLORS.p90 },
    { key: "p95", label: "p95", color: SERIES_COLORS.p95 },
  ];

  const byKey = new Map(perBucket.map((r) => [bucketKey(r.bucket), r]));
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

  const overallCnt = overall.cnt ?? 0;
  const { p50: p50All, p90: p90All, p95: p95All } = overall;

  const hrefWith = (overrides: Record<string, string>): string => {
    const p = new URLSearchParams();
    p.set("range", range);
    p.set("segment", segment);
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    return `${pathname}?${p.toString()}`;
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
            options={segments as readonly ("day" | "week" | "month")[]}
            value={segment}
            hrefFor={(s) => hrefWith({ segment: s })}
          />
          <AnalyticsButtonGroup
            options={ranges as readonly ("7d" | "14d" | "30d" | "90d")[]}
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
