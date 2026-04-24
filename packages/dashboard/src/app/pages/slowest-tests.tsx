import { type Kysely, sql } from "kysely";
import {
  CheckCircle2,
  ChevronRight,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { AnalyticsButtonGroup } from "@/app/components/analytics/button-group";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/app/components/analytics/bucket-bar-chart";
import { InsightsTabs } from "@/app/components/analytics/insights-tabs";
import { RunHistoryBranchFilter } from "@/app/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/app/components/run-history-branch-filter.shared";
import { Card, CardPanel } from "@/app/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/app/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";
import { cn } from "@/lib/cn";
import { STATUS_COLORS } from "@/lib/status";
import type { TenantDatabase } from "@/tenant";
import { formatDuration } from "@/lib/time-format";

type RangeKey = "7d" | "30d" | "90d" | "all";
const RANGES: readonly RangeKey[] = ["7d", "30d", "90d", "all"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "30d");

const HIST_BINS = 20;
const PAGE_SIZE = 20;
const SPARKLINE_DAYS = 7;
const DAY_SEC = 86_400;

export async function SlowestTestsPage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const range = parseRange(url.searchParams.get("range"));
  const branchParam = url.searchParams.get("branch");
  const branchFilter =
    !branchParam || branchParam === ALL_BRANCHES ? null : branchParam;
  const q = (url.searchParams.get("q") ?? "").trim();
  const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPage =
    Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const nowSec = Math.floor(Date.now() / 1000);
  const rangeSec = rangeToSeconds(range);
  const windowStartSec = rangeSec ? nowSec - rangeSec : 0;

  const tenantDb = project.db;
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  // Distinct branch list for the filter UI. Same shape as flaky-tests.
  const branchRows = await tenantDb
    .selectFrom("runs")
    .select("branch as value")
    .distinct()
    .where("projectId", "=", project.id)
    .where("committed", "=", 1)
    .where("branch", "is not", null)
    .execute();
  const branches = branchRows
    .map((r) => r.value)
    .filter((v): v is string => !!v)
    .sort();

  // Max durationMs over the window — used to pick a sensible histogram
  // bin width. Runs in parallel with the unique-test count query so the
  // page latency is one round-trip, not two.
  const branchClause = branchFilter
    ? sql`AND "runs"."branch" = ${branchFilter}`
    : sql``;
  const searchClause = q
    ? sql`AND ("testResults"."title" LIKE ${`%${q}%`} OR "testResults"."file" LIKE ${`%${q}%`})`
    : sql``;

  const [maxRes, distinctRes] = await Promise.all([
    sql<{ maxDur: number | null; n: number }>`
      SELECT
        MAX("testResults"."durationMs") AS "maxDur",
        COUNT(*) AS "n"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${project.id}
        AND "runs"."committed" = 1
        AND "testResults"."createdAt" >= ${windowStartSec}
        AND "testResults"."status" != 'skipped'
        ${branchClause}
        ${searchClause}
    `.execute(tenantDb),
    sql<{ n: number }>`
      SELECT COUNT(DISTINCT "testResults"."testId") AS "n"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${project.id}
        AND "runs"."committed" = 1
        AND "testResults"."createdAt" >= ${windowStartSec}
        AND "testResults"."status" != 'skipped'
        ${branchClause}
        ${searchClause}
    `.execute(tenantDb),
  ]);

  const totalResults = maxRes.rows[0]?.n ?? 0;
  const maxDurationMs = maxRes.rows[0]?.maxDur ?? 0;
  const totalUniqueTests = distinctRes.rows[0]?.n ?? 0;

  // Bin width chosen from observed max duration. Rounded to a "nice"
  // number so the x-axis reads cleanly ("every 2s" beats "every 1873ms").
  // Inlined as SQL literals via `sql.raw` — the DO-SQLite driver binds
  // params with text affinity, so `/ ${bucketMs}` would silently turn
  // integer division into string concatenation and return one huge bin.
  // Same class of bug documented in analytics/bucketing.ts.
  const bucketMs = pickBinWidthMs(maxDurationMs);
  const topBin = HIST_BINS - 1;

  const histRows =
    totalResults === 0
      ? { rows: [] as { bin: number; cnt: number }[] }
      : await sql<{ bin: number; cnt: number }>`
      SELECT
        CAST(
          CASE
            WHEN "testResults"."durationMs" >= ${sql.raw(String(bucketMs * HIST_BINS))}
            THEN ${sql.raw(String(topBin))}
            ELSE "testResults"."durationMs" / ${sql.raw(String(bucketMs))}
          END AS INTEGER
        ) AS "bin",
        COUNT(*) AS "cnt"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${project.id}
        AND "runs"."committed" = 1
        AND "testResults"."createdAt" >= ${windowStartSec}
        AND "testResults"."status" != 'skipped'
        ${branchClause}
        ${searchClause}
      GROUP BY "bin"
    `.execute(tenantDb);

  const histByBin = new Map(histRows.rows.map((r) => [r.bin, r.cnt]));
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

  // Paginated bottlenecks. Window functions compute a duration-sorted
  // rank (for p95) and a time-sorted rank (to pick the latest title /
  // file / status). Everything else is a plain aggregate.
  //
  // Payload stays at PAGE_SIZE rows regardless of suite size — ranked-CTE
  // work happens inside SQLite, not in the Worker.
  const totalPages = Math.max(1, Math.ceil(totalUniqueTests / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const bottleneckRows =
    totalUniqueTests === 0
      ? { rows: [] as BottleneckRow[] }
      : await sql<BottleneckRow>`
      WITH filtered AS (
        SELECT
          "testResults"."testId" AS "testId",
          "testResults"."durationMs" AS "durationMs",
          "testResults"."title" AS "title",
          "testResults"."file" AS "file",
          "testResults"."status" AS "status",
          "testResults"."createdAt" AS "createdAt",
          "testResults"."runId" AS "runId",
          "testResults"."id" AS "testResultId"
        FROM "testResults"
        INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
        WHERE "runs"."projectId" = ${project.id}
          AND "runs"."committed" = 1
          AND "testResults"."createdAt" >= ${windowStartSec}
          AND "testResults"."status" != 'skipped'
          ${branchClause}
          ${searchClause}
      ),
      ranked AS (
        SELECT
          "testId", "durationMs", "title", "file", "status",
          "createdAt", "runId", "testResultId",
          row_number() OVER (PARTITION BY "testId" ORDER BY "durationMs") AS "rnDur",
          row_number() OVER (PARTITION BY "testId" ORDER BY "createdAt" DESC) AS "rnTime",
          count(*) OVER (PARTITION BY "testId") AS "cnt"
        FROM filtered
      )
      SELECT
        "testId",
        MAX("cnt") AS "n",
        AVG("durationMs") AS "avgDur",
        MIN(CASE WHEN "rnDur" = MAX(1, CAST(ROUND("cnt" * 0.95) AS INTEGER)) THEN "durationMs" END) AS "p95",
        MAX(CASE WHEN "rnTime" = 1 THEN "title" END) AS "title",
        MAX(CASE WHEN "rnTime" = 1 THEN "file" END) AS "file",
        MAX(CASE WHEN "rnTime" = 1 THEN "runId" END) AS "latestRunId",
        MAX(CASE WHEN "rnTime" = 1 THEN "testResultId" END) AS "latestTestResultId",
        SUM(CASE WHEN "status" IN ('failed', 'timedout') THEN 1 ELSE 0 END) AS "failCount",
        SUM(CASE WHEN "status" = 'flaky' THEN 1 ELSE 0 END) AS "flakyCount"
      FROM ranked
      GROUP BY "testId"
      ORDER BY "p95" DESC
      LIMIT ${PAGE_SIZE}
      OFFSET ${offset}
    `.execute(tenantDb);

  const bottlenecks = bottleneckRows.rows;
  const pageTestIds = bottlenecks.map((r) => r.testId);

  // Daily-avg sparkline data, limited to the current page's testIds.
  // Always uses the last 7 days so the sparkline is a consistent
  // "recent trend" marker regardless of the selected range.
  const sparklines = await loadSparklines(
    tenantDb,
    project.id,
    pageTestIds,
    branchFilter,
    nowSec,
  );

  const fromRow = totalUniqueTests === 0 ? 0 : offset + 1;
  const toRow = offset + bottlenecks.length;

  const hrefWith = (overrides: Record<string, string | null>): string => {
    const p = new URLSearchParams(url.searchParams);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `${url.pathname}?${p.toString()}`;
  };

  const pageHref = (page: number): string =>
    hrefWith({ page: page === 1 ? null : String(page) });

  const pageWindow = buildPageWindow(currentPage, totalPages);

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
            options={RANGES}
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
                {maxDurationMs > 0
                  ? ` · bin width ${formatDuration(bucketMs)}`
                  : ""}
              </p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              n={totalResults.toLocaleString()}
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
                {totalUniqueTests.toLocaleString()} unique test
                {totalUniqueTests === 1 ? "" : "s"} · sorted by p95 desc
              </p>
            </div>
            <form className="relative" method="get">
              {/* Preserve other params on search submit. */}
              {Array.from(url.searchParams.entries())
                .filter(([k]) => k !== "q" && k !== "page")
                .map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
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
                      : `No committed runs with recorded durations in the selected window${
                          branchFilter ? ` on ${branchFilter}` : ""
                        }.`}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent dark:hover:bg-transparent">
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
                    const spark = sparklines.get(row.testId) ?? [];
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
                          <a
                            href={href}
                            className="block truncate font-mono text-sm text-foreground hover:underline"
                          >
                            {row.title ?? row.testId}
                          </a>
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
                          <a href={href} aria-label="Open latest run">
                            <ChevronRight size={14} />
                          </a>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardPanel>
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-4 border-t border-border/50 px-6 py-3 text-xs font-mono text-muted-foreground">
              <span>
                Showing {fromRow}–{toRow} of {totalUniqueTests.toLocaleString()}{" "}
                tests
              </span>
              <Pagination className="mx-0 w-auto justify-end">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      href={
                        currentPage > 1 ? pageHref(currentPage - 1) : undefined
                      }
                      aria-disabled={currentPage === 1}
                      className={cn(
                        currentPage === 1 && "pointer-events-none opacity-50",
                      )}
                    />
                  </PaginationItem>
                  {pageWindow.map((entry, i) =>
                    entry === "ellipsis" ? (
                      <PaginationItem key={`ellipsis-${i}`}>
                        <PaginationEllipsis />
                      </PaginationItem>
                    ) : (
                      <PaginationItem key={entry}>
                        <PaginationLink
                          href={pageHref(entry)}
                          isActive={entry === currentPage}
                        >
                          {entry}
                        </PaginationLink>
                      </PaginationItem>
                    ),
                  )}
                  <PaginationItem>
                    <PaginationNext
                      href={
                        currentPage < totalPages
                          ? pageHref(currentPage + 1)
                          : undefined
                      }
                      aria-disabled={currentPage >= totalPages}
                      className={cn(
                        currentPage >= totalPages &&
                          "pointer-events-none opacity-50",
                      )}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ---- types & helpers -------------------------------------------------

interface BottleneckRow {
  testId: string;
  n: number;
  avgDur: number | null;
  p95: number | null;
  title: string | null;
  file: string | null;
  latestRunId: string | null;
  latestTestResultId: string | null;
  failCount: number;
  flakyCount: number;
}

interface SparklinePoint {
  day: number;
  avg: number;
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

/**
 * Round-up a bin width to a readable value. Mapping is coarse on
 * purpose — the x-axis labels are all ~2-3 digits wide this way, so
 * readers can compare bins without decoding milliseconds.
 */
function pickBinWidthMs(maxDurationMs: number): number {
  if (maxDurationMs <= 0) return 100;
  const raw = Math.ceil(maxDurationMs / HIST_BINS);
  const nice = [
    100, 200, 250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 15_000, 30_000,
    60_000, 120_000, 300_000, 600_000,
  ];
  for (const n of nice) if (raw <= n) return n;
  // For very long tests, jump to 10-minute bins — good enough for a
  // 200-minute test (bin 20 tops out at 200 min).
  return 600_000;
}

async function loadSparklines(
  db: Kysely<TenantDatabase>,
  projectId: string,
  testIds: string[],
  branch: string | null,
  nowSec: number,
): Promise<Map<string, SparklinePoint[]>> {
  const out = new Map<string, SparklinePoint[]>();
  if (testIds.length === 0) return out;

  const sparkStart = nowSec - SPARKLINE_DAYS * DAY_SEC;
  const branchClause = branch ? sql`AND "runs"."branch" = ${branch}` : sql``;

  // Day bucket uses a literal divisor for the same DO-SQLite text-affinity
  // reason documented in analytics/bucketing.ts.
  const { rows } = await sql<{
    testId: string;
    day: number;
    avg: number;
  }>`
    SELECT
      "testResults"."testId" AS "testId",
      CAST("testResults"."createdAt" / 86400 AS INTEGER) AS "day",
      AVG("testResults"."durationMs") AS "avg"
    FROM "testResults"
    INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
    WHERE "runs"."projectId" = ${projectId}
      AND "runs"."committed" = 1
      AND "testResults"."createdAt" >= ${sparkStart}
      AND "testResults"."status" != 'skipped'
      AND "testResults"."testId" IN (${sql.join(testIds)})
      ${branchClause}
    GROUP BY "testResults"."testId", "day"
    ORDER BY "testResults"."testId", "day"
  `.execute(db);

  for (const r of rows) {
    let entry = out.get(r.testId);
    if (!entry) {
      entry = [];
      out.set(r.testId, entry);
    }
    entry.push({ day: r.day, avg: r.avg });
  }
  return out;
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

function buildPageWindow(
  current: number,
  total: number,
): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push("ellipsis");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push("ellipsis");
  pages.push(total);
  return pages;
}
