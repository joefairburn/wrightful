import { Activity, CheckCircle2, TriangleAlert } from "lucide-react";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { Card, CardPanel } from "@/components/ui/card";
import { bucketKey, buildEmptyBuckets } from "@/lib/analytics/bucketing";
import { statusColor } from "@/lib/status";
import type { Props } from "./index.server";

/**
 * Insights → Run Status (default). Stacked-bar bucket chart of pass/fail/
 * flaky/skipped counts per segment, plus three KPI cards (pass rate,
 * flakiness rate, total runs).
 */
export default function InsightsPage({
  project,
  range,
  segment,
  days,
  nowSec,
  windowStartSec,
  pathname,
  aggRows,
  segments,
  ranges,
}: Props) {
  const shells = buildEmptyBuckets(segment, windowStartSec, nowSec);
  const byKey = new Map(aggRows.map((r) => [bucketKey(r.bucket), r]));

  const passedColor = statusColor("passed");
  const failedColor = statusColor("failed");
  const flakyColor = statusColor("flaky");
  const skippedColor = statusColor("skipped");

  const buckets: BucketBarChartBucket[] = shells.map((s) => {
    const row = byKey.get(s.key);
    const passed = row?.passed ?? 0;
    const failed = row?.failed ?? 0;
    const flaky = row?.flaky ?? 0;
    const skipped = row?.skipped ?? 0;
    const runs = row?.runs ?? 0;
    const total = passed + failed + flaky + skipped;
    return {
      key: s.key,
      label: s.label,
      total,
      segments: [
        { count: passed, color: passedColor },
        { count: failed, color: failedColor },
        { count: flaky, color: flakyColor },
        { count: skipped, color: skippedColor },
      ],
      tooltip: (
        <>
          <div className="mb-2 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label}
          </div>
          <div className="space-y-1 font-mono text-[11px]">
            <TooltipRow label="Passed" value={passed} color={passedColor} />
            <TooltipRow label="Failed" value={failed} color={failedColor} />
            <TooltipRow label="Flaky" value={flaky} color={flakyColor} />
            <TooltipRow label="Skipped" value={skipped} color={skippedColor} />
            <div className="mt-1 flex justify-between border-t border-border/50 pt-1 text-muted-foreground">
              <span>Runs</span>
              <span>{runs.toLocaleString()}</span>
            </div>
          </div>
        </>
      ),
    };
  });

  let totalPassed = 0;
  let totalFailed = 0;
  let totalFlaky = 0;
  let totalRuns = 0;
  for (const r of aggRows) {
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalFlaky += r.flaky;
    totalRuns += r.runs;
  }
  const executed = totalPassed + totalFailed + totalFlaky;
  const passRate = executed === 0 ? 0 : (totalPassed / executed) * 100;
  const flakyRate = executed === 0 ? 0 : (totalFlaky / executed) * 100;
  const avgRunsPerDay = totalRuns / days;

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
        active="run-status"
      />

      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Run Status Analytics
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wider">
            Historical outcome distribution · Last {days} days
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
            label="Avg Pass Rate"
            value={`${passRate.toFixed(1)}%`}
            Icon={CheckCircle2}
            iconColor={passedColor}
            footnote={executed === 0 ? "No executions in window" : undefined}
          />
          <AnalyticsKpiCard
            label="Flakiness Rate"
            value={`${flakyRate.toFixed(1)}%`}
            Icon={TriangleAlert}
            iconColor={flakyColor}
            footnote={`${totalFlaky.toLocaleString()} flaky of ${executed.toLocaleString()} executed`}
          />
          <AnalyticsKpiCard
            label="Total Runs"
            value={totalRuns.toLocaleString()}
            Icon={Activity}
            footnote={`~${avgRunsPerDay.toFixed(avgRunsPerDay < 10 ? 1 : 0)} runs / day avg`}
          />
        </div>

        <Card>
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div>
              <h2 className="text-base font-semibold">
                Execution Volume &amp; Outcomes
              </h2>
              <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                Runs grouped by {segment}
              </p>
            </div>
            <Legend
              items={[
                { label: "Passed", color: passedColor },
                { label: "Failed", color: failedColor },
                { label: "Flaky", color: flakyColor },
                { label: "Skipped", color: skippedColor },
              ]}
            />
          </div>
          <CardPanel className="pt-0">
            <BucketBarChart
              buckets={buckets}
              height={420}
              ariaLabel={`Run outcomes across ${buckets.length} buckets`}
            />
          </CardPanel>
        </Card>
      </div>
    </>
  );
}

function TooltipRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: color }}
        />
        <span className="text-foreground">{label}</span>
      </span>
      <span className="text-foreground">{value.toLocaleString()}</span>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="hidden sm:flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: it.color }}
          />
          {it.label}
        </div>
      ))}
    </div>
  );
}
