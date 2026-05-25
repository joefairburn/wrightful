import { Database, ListPlus } from "lucide-react";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { Card, CardPanel } from "@/components/ui/card";
import { bucketKey, buildEmptyBuckets } from "@/lib/analytics/bucketing";
import { cn } from "@/lib/cn";
import type { Props } from "./suite-size.server";

function rangeLabel(r: string): string {
  if (r === "all") return "All time";
  if (r === "1y") return "Last year";
  return `Last ${parseInt(r, 10)} days`;
}

/**
 * Suite Size analytics page. Trend chart (peak suite size per bucket) plus
 * KPIs (total tests, tests added in last 30d), distribution by spec file,
 * and top tags.
 */
export default function SuiteSizePage({
  project,
  range,
  segment,
  nowSec,
  shellStartSec,
  trendRows,
  testsAdded,
  addedLookbackDays,
  peakOverall,
  fileRows,
  tagRows,
  pathname,
  segments,
  ranges,
}: Props) {
  const shells = buildEmptyBuckets(segment, shellStartSec, nowSec);
  const peaksByKey = new Map(
    trendRows.map((r) => [bucketKey(r.bucket), r.peak]),
  );
  const primaryColor = "var(--color-primary)";
  const buckets: BucketBarChartBucket[] = shells.map((s) => {
    const peak = peaksByKey.get(s.key) ?? 0;
    return {
      key: s.key,
      label: s.label,
      total: peak,
      segments: [{ count: peak, color: primaryColor }],
      tooltip: (
        <>
          <div className="mb-1 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label}
          </div>
          <div className="font-mono text-xs">
            <span className="text-foreground">{peak.toLocaleString()}</span>{" "}
            <span className="text-muted-foreground">tests</span>
          </div>
        </>
      ),
    };
  });

  const fileTotal = fileRows.reduce((acc, r) => acc + r.tests, 0);

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
        active="suite-size"
      />

      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Suite Size Growth
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wider">
            Test volume and distribution · {rangeLabel(range)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsButtonGroup
            options={segments as readonly ("day" | "week" | "month")[]}
            value={segment}
            hrefFor={(s) => hrefWith({ segment: s })}
          />
          <AnalyticsButtonGroup
            options={ranges as readonly ("7d" | "30d" | "90d" | "1y" | "all")[]}
            value={range}
            hrefFor={(r) => hrefWith({ range: r })}
            labelFor={(r) => r.toUpperCase()}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 flex flex-col gap-4">
            <AnalyticsKpiCard
              label="Total Tests"
              value={peakOverall.toLocaleString()}
              Icon={Database}
              footnote="Peak suite size observed in the window"
            />
            <AnalyticsKpiCard
              label={`Tests Added (${addedLookbackDays}d)`}
              value={testsAdded.toLocaleString()}
              Icon={ListPlus}
              footnote="Tests whose first-ever run is in the last 30 days"
            />
          </div>
          <div className="lg:col-span-8">
            <Card>
              <div className="flex items-center justify-between px-6 pt-5 pb-3">
                <div>
                  <h2 className="text-base font-semibold">Growth Trend</h2>
                  <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                    Peak suite size per {segment}
                  </p>
                </div>
              </div>
              <CardPanel className="pt-0">
                <BucketBarChart
                  buckets={buckets}
                  height={360}
                  ariaLabel={`Suite size trend across ${buckets.length} buckets`}
                  emptyState="No runs in this window."
                />
              </CardPanel>
            </Card>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Card>
              <div className="px-6 pt-5 pb-3">
                <h2 className="text-base font-semibold">
                  Distribution by spec file
                </h2>
                <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                  Top {fileRows.length} files by distinct test count
                </p>
              </div>
              <CardPanel className="pt-0">
                {fileRows.length === 0 ? (
                  <EmptyRow>No tests in this window.</EmptyRow>
                ) : (
                  <ul className="space-y-3">
                    {fileRows.map((r) => (
                      <DistributionRow
                        key={r.file}
                        label={r.file}
                        value={r.tests}
                        total={fileTotal}
                      />
                    ))}
                  </ul>
                )}
              </CardPanel>
            </Card>
          </div>

          <div className="lg:col-span-1">
            <Card>
              <div className="px-6 pt-5 pb-3">
                <h2 className="text-base font-semibold">Top tags</h2>
                <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                  Distinct tests per tag
                </p>
              </div>
              <CardPanel className="pt-0">
                {tagRows.length === 0 ? (
                  <EmptyRow>No tagged tests.</EmptyRow>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {tagRows.map((r) => (
                      <span
                        key={r.tag}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 font-mono text-xs text-foreground"
                      >
                        <span>{r.tag}</span>
                        <span className="text-muted-foreground">
                          {r.tests.toLocaleString()}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </CardPanel>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

function DistributionRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : (value / total) * 100;
  return (
    <li className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {label}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full bg-foreground/80")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="w-16 text-right font-mono text-sm text-foreground">
        {value.toLocaleString()}
      </div>
      <div className="w-12 text-right font-mono text-[11px] text-muted-foreground">
        {pct.toFixed(0)}%
      </div>
    </li>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
