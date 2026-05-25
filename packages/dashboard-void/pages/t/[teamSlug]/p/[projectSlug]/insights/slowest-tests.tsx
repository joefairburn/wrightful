import {
  CheckCircle2,
  ChevronRight,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Link } from "@void/react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { Card, CardPanel } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { STATUS_COLORS } from "@/lib/status";
import { formatDuration } from "@/lib/time-format";
import type {
  BottleneckRow,
  Props,
  SparklinePoint,
} from "./slowest-tests.server";

const HIST_BINS = 20;

/**
 * Slowest tests page. Two views composed:
 *   - Top: 20-bin histogram of test durations over the selected window.
 *   - Bottom: paginated table of testIds ranked by p95 (avg, runs, 7d trend).
 */
export default function SlowestTestsPage({
  project,
  range,
  branchParam,
  branches,
  branchFilter,
  q,
  currentPage,
  totalPages,
  fromRow,
  toRow,
  totals,
  bucketMs,
  histogram,
  bottlenecks,
  sparklines,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const topBin = HIST_BINS - 1;

  const histByBin = new Map(histogram.map((r) => [r.bin, r.cnt]));
  const histBuckets: BucketBarChartBucket[] = Array.from(
    { length: HIST_BINS },
    (_, i) => {
      const cnt = histByBin.get(i) ?? 0;
      const loMs = i * bucketMs;
      const hiMs = (i + 1) * bucketMs;
      const label =
        i === topBin ? `${formatDuration(loMs)}+` : formatDuration(loMs);
      return {
        key: String(i),
        label,
        segments: [{ count: cnt, color: "var(--color-primary)" }],
        total: cnt,
        tooltip: (
          <>
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">
              {i === topBin
                ? `${formatDuration(loMs)}+`
                : `${formatDuration(loMs)} – ${formatDuration(hiMs)}`}
            </div>
            <div className="font-mono text-xs">
              {cnt.toLocaleString()} test{cnt === 1 ? "" : "s"}
            </div>
          </>
        ),
      };
    },
  );

  const hrefWith = (overrides: Record<string, string | null>): string => {
    const p = new URLSearchParams();
    p.set("range", range);
    if (branchParam) p.set("branch", branchParam);
    if (q) p.set("q", q);
    if (currentPage > 1) p.set("page", String(currentPage));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `${pathname}?${p.toString()}`;
  };

  const pageHref = (page: number): string =>
    hrefWith({ page: page === 1 ? null : String(page) });

  return (
    <>
      <InsightsTabs
        teamSlug={project.teamSlug}
        projectSlug={project.slug}
        active="slowest-tests"
      />

      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Slowest Tests
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wider">
            Duration distribution · tests ranked by p95
          </p>
          <div className="mt-2">
            <RunHistoryBranchFilter
              branches={branches}
              defaultValue={branchParam ?? ALL_BRANCHES}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsButtonGroup
            options={ranges as readonly ("7d" | "30d" | "90d" | "all")[]}
            value={range}
            hrefFor={(r) => hrefWith({ range: r, page: null })}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">
        <Card>
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div>
              <h2 className="text-base font-semibold">
                Execution Time Distribution
              </h2>
              <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                Count of test results per duration bin
                {totals.maxDurationMs > 0
                  ? ` · bin width ${formatDuration(bucketMs)}`
                  : ""}
              </p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              n={totals.totalResults.toLocaleString()}
            </span>
          </div>
          <CardPanel className="pt-0">
            <BucketBarChart
              buckets={histBuckets}
              height={220}
              ariaLabel="Execution time distribution histogram"
              emptyState="No runs in this window."
            />
          </CardPanel>
        </Card>

        <Card>
          <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
            <div>
              <h2 className="text-base font-semibold">Slowest Tests</h2>
              <p className="mt-0.5 text-xs font-mono text-muted-foreground">
                {totals.totalUniqueTests.toLocaleString()} unique test
                {totals.totalUniqueTests === 1 ? "" : "s"} · sorted by p95 desc
              </p>
            </div>
            <form className="relative" method="get">
              {/* Preserve other params on search submit. */}
              <input type="hidden" name="range" value={range} />
              {branchParam ? (
                <input type="hidden" name="branch" value={branchParam} />
              ) : null}
              <input
                type="text"
                name="q"
                defaultValue={q}
                placeholder="Filter path or name..."
                className="w-56 rounded-md border border-border bg-background px-3 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/24"
              />
            </form>
          </div>
          <CardPanel className="pt-0">
            {bottlenecks.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No tests in this window</EmptyTitle>
                  <EmptyDescription>
                    {q
                      ? `No tests match "${q}". Try a wider window or clear the filter.`
                      : `No runs with recorded durations in the selected window${
                          branchFilter ? ` on ${branchFilter}` : ""
                        }.`}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
                      Status
                    </TableHead>
                    <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
                      Test Name & Path
                    </TableHead>
                    <TableHead className="w-28 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                      Avg
                    </TableHead>
                    <TableHead className="w-28 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                      P95
                    </TableHead>
                    <TableHead className="w-28 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
                      Trend (7d)
                    </TableHead>
                    <TableHead className="w-16 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                      Runs
                    </TableHead>
                    <TableHead className="w-10 px-2" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bottlenecks.map((row) => {
                    const tone = rowTone(row);
                    const href = `${base}/runs/${row.latestRunId}/tests/${row.latestTestResultId}?attempt=0`;
                    const spark = sparklines[row.testId] ?? [];
                    return (
                      <TableRow
                        key={row.testId}
                        className={cn(
                          "border-b border-border/50 border-l-2",
                          tone.border,
                        )}
                      >
                        <TableCell className="px-4 py-3 text-center align-middle">
                          <tone.Icon
                            size={18}
                            style={{ color: tone.iconColor }}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-3 max-w-md">
                          <Link
                            href={href}
                            className="block truncate font-mono text-sm text-foreground hover:underline"
                          >
                            {row.title ?? row.testId}
                          </Link>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                            {row.file ?? ""}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-foreground">
                          {row.avgDur === null
                            ? "—"
                            : formatDuration(Math.round(row.avgDur))}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "px-4 py-3 text-right font-mono text-xs tabular-nums font-medium",
                            tone.p95Text,
                          )}
                        >
                          {row.p95 === null
                            ? "—"
                            : formatDuration(Math.round(row.p95))}
                        </TableCell>
                        <TableCell className="px-4 py-3 text-center align-middle">
                          <DurationSparkline
                            points={spark}
                            color={tone.sparkColor}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {row.n.toLocaleString()}
                        </TableCell>
                        <TableCell className="px-2 py-3 text-center text-muted-foreground">
                          <Link href={href} aria-label="Open latest run">
                            <ChevronRight size={14} />
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardPanel>
          {totalPages > 1 && (
            <TablePaginationFooter
              fromRow={fromRow}
              toRow={toRow}
              totalCount={totals.totalUniqueTests}
              currentPage={currentPage}
              totalPages={totalPages}
              itemNoun="test"
              pageHref={pageHref}
              className="border-border/50"
            />
          )}
        </Card>
      </div>
    </>
  );
}

interface RowTone {
  Icon: typeof CheckCircle2;
  iconColor: string;
  border: string;
  p95Text: string;
  sparkColor: string;
}

function rowTone(row: BottleneckRow): RowTone {
  if (row.failCount > 0) {
    return {
      Icon: XCircle,
      iconColor: STATUS_COLORS.failed,
      border: "border-l-destructive",
      p95Text: "text-destructive-foreground",
      sparkColor: STATUS_COLORS.failed,
    };
  }
  if (row.flakyCount > 0) {
    return {
      Icon: TriangleAlert,
      iconColor: STATUS_COLORS.flaky,
      border: "border-l-warning",
      p95Text: "text-warning-foreground",
      sparkColor: STATUS_COLORS.flaky,
    };
  }
  return {
    Icon: CheckCircle2,
    iconColor: STATUS_COLORS.passed,
    border: "border-l-border",
    p95Text: "text-muted-foreground",
    sparkColor: STATUS_COLORS.passed,
  };
}

function DurationSparkline({
  points,
  color,
}: {
  points: SparklinePoint[];
  color: string;
}) {
  const w = 80;
  const h = 20;
  if (points.length === 0) {
    return (
      <svg
        width={w}
        height={h}
        style={{ display: "block", margin: "0 auto" }}
        role="img"
        aria-label="No data"
      />
    );
  }
  if (points.length === 1) {
    return (
      <svg
        width={w}
        height={h}
        style={{ display: "block", margin: "0 auto" }}
        role="img"
        aria-label="Single data point"
      >
        <circle cx={w / 2} cy={h / 2} r={1.5} fill={color} />
      </svg>
    );
  }
  const xs = points.map((p) => p.day);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const ys = points.map((p) => p.avg);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeY = maxY - minY || 1;
  const rangeX = maxX - minX || 1;

  const path = points
    .map((p, i) => {
      const x = ((p.day - minX) / rangeX) * (w - 2) + 1;
      const y = h - 1 - ((p.avg - minY) / rangeY) * (h - 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={w}
      height={h}
      style={{ display: "block", margin: "0 auto" }}
      role="img"
      aria-label="7-day duration trend"
    >
      <path d={path} stroke={color} strokeWidth={1.25} fill="none" />
    </svg>
  );
}
