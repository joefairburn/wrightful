import { type Kysely, sql } from "kysely";
import { requestInfo } from "rwsdk/worker";
import { FlakyTestRow } from "@/app/components/flaky-test-row";
import { RunHistoryBranchFilter } from "@/app/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/app/components/run-history-branch-filter.shared";
import type { TenantDatabase } from "@/tenant";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/cn";

const TOP_N = 50;
const SPARKLINE_SIZE = 20;
const RECENT_FAILURES = 3;

type RangeKey = "7d" | "14d" | "30d";
const RANGES: RangeKey[] = ["7d", "14d", "30d"];
const DEFAULT_RANGE: RangeKey = "14d";

function parseRange(value: string | null): RangeKey {
  if (value === "7d" || value === "14d" || value === "30d") return value;
  return DEFAULT_RANGE;
}

function rangeToDays(r: RangeKey): number {
  return r === "7d" ? 7 : r === "14d" ? 14 : 30;
}

export async function FlakyTestsPage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const range = parseRange(url.searchParams.get("range"));
  const branchParam = url.searchParams.get("branch");
  const branchAll = !branchParam || branchParam === ALL_BRANCHES;
  const branchFilter = branchAll ? null : branchParam;
  // createdAt is stored as unix seconds (see packages/dashboard/src/lib/time-format.ts).
  const windowStart =
    Math.floor(Date.now() / 1000) - rangeToDays(range) * 24 * 60 * 60;

  const tenantDb = project.db;
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  // Aggregate per-testId status counts over the window. Flakiness is
  // flaky / (flaky + passed) per the product decision — hard failures are
  // excluded from both numerator and denominator so they don't mask an
  // actual flake rate. We still surface `total` for context.
  let agg = tenantDb
    .selectFrom("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("runs.projectId", "=", project.id)
    .where("runs.committed", "=", 1)
    .where("testResults.createdAt", ">=", windowStart);
  if (branchFilter) agg = agg.where("runs.branch", "=", branchFilter);

  const aggregates = await agg
    .select([
      "testResults.testId as testId",
      // `total` excludes skipped runs so the displayed "flaky / total" only
      // counts runs where the test actually executed.
      sql<number>`sum(case when testResults.status != 'skipped' then 1 else 0 end)`.as(
        "total",
      ),
      sql<number>`sum(case when testResults.status = 'flaky' then 1 else 0 end)`.as(
        "flakyCount",
      ),
      sql<number>`sum(case when testResults.status = 'passed' then 1 else 0 end)`.as(
        "passedCount",
      ),
    ])
    .groupBy("testResults.testId")
    .having(
      sql<number>`sum(case when testResults.status = 'flaky' then 1 else 0 end)`,
      ">=",
      1,
    )
    .execute();

  const rankedAll = aggregates
    .map((r) => {
      const denom = r.flakyCount + r.passedCount;
      const pct = denom === 0 ? 0 : (r.flakyCount / denom) * 100;
      return { ...r, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.flakyCount - a.flakyCount);
  const totalFlakyTests = rankedAll.length;
  const ranked = rankedAll.slice(0, TOP_N);
  const truncated = totalFlakyTests > ranked.length;

  // Branch list for the filter UI (distinct committed branches on this
  // project). Mirrors the runs-list pattern.
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

  // Sparkline data + latest title/file + recent failures. Two single-pass
  // queries using `row_number()` partitioned by testId — the DO SQLite
  // would serialize a TOP_N fan-out anyway, so collapsing to two queries
  // is strictly better.
  const testIds = ranked.map((r) => r.testId);
  const [sparkByTest, failsByTest] = await Promise.all([
    loadSparklinesAndMeta(tenantDb, project.id, testIds, branchFilter),
    loadRecentFailures(tenantDb, project.id, testIds, branchFilter),
  ]);

  const rangeHref = (r: RangeKey): string => {
    const p = new URLSearchParams(url.searchParams);
    p.set("range", r);
    return `${url.pathname}?${p.toString()}`;
  };

  return (
    <>
      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {totalFlakyTests} Flaky Test{totalFlakyTests === 1 ? "" : "s"}
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            Tests exhibiting unstable behavior across recent CI runs
            {truncated ? ` — showing top ${ranked.length}` : ""}.
          </p>
          <div className="mt-2">
            <RunHistoryBranchFilter
              branches={branches}
              defaultValue={branchParam ?? ALL_BRANCHES}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-background p-0.5">
            {RANGES.map((r) => (
              <a
                key={r}
                href={rangeHref(r)}
                className={cn(
                  "px-3 py-1 text-xs font-mono rounded transition-colors",
                  range === r
                    ? "bg-muted text-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r}
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {ranked.length === 0 ? (
          <div className="flex items-center justify-center h-full p-10">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No flaky tests in this window</EmptyTitle>
                <EmptyDescription>
                  Nothing failed on retry in the last {rangeToDays(range)} days
                  {branchAll ? "" : ` on ${branchParam}`}. Try a wider window or
                  a different branch.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <span className="text-xs text-muted-foreground font-mono">
                  {branches.length > 0 && (
                    <>
                      Branches: {branches.slice(0, 3).join(", ")}
                      {branches.length > 3 ? "…" : ""}
                    </>
                  )}
                </span>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm">
              <TableRow className="border-b border-border hover:bg-transparent dark:hover:bg-transparent">
                <TableHead className="w-12 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
                  Rank
                </TableHead>
                <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
                  Test Specification
                </TableHead>
                <TableHead className="w-28 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                  Flakiness
                </TableHead>
                <TableHead className="w-28 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                  Flaky / Total
                </TableHead>
                <TableHead className="w-48 px-4 font-mono text-[11px] uppercase tracking-wider">
                  Recent Trend
                </TableHead>
                <TableHead className="w-10 px-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((row, i) => {
                const meta = sparkByTest.get(row.testId);
                const fails = failsByTest.get(row.testId) ?? [];
                const latest = fails[0];
                const latestHref = latest
                  ? `${base}/runs/${latest.runId}/tests/${latest.testResultId}?attempt=0`
                  : base;
                return (
                  <FlakyTestRow
                    key={row.testId}
                    rank={i + 1}
                    testId={row.testId}
                    title={meta?.title ?? row.testId}
                    file={meta?.file ?? ""}
                    total={row.total}
                    flakyCount={row.flakyCount}
                    pct={row.pct}
                    sparklinePoints={meta?.sparkline ?? []}
                    recentFailures={fails}
                    projectBase={base}
                    historyHref={latestHref}
                  />
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}

interface TestMeta {
  sparkline: { status: string }[];
  title: string;
  file: string;
}

// Fetches the last SPARKLINE_SIZE rows per testId in a single query. We use
// the rn=1 row (latest by createdAt) as the authoritative title/file for
// the ranking display — safer than `max(title)` which would pick a
// lexicographic winner after a rename.
async function loadSparklinesAndMeta(
  db: Kysely<TenantDatabase>,
  projectId: string,
  testIds: string[],
  branch: string | null,
): Promise<Map<string, TestMeta>> {
  const out = new Map<string, TestMeta>();
  if (testIds.length === 0) return out;

  const branchClause = branch ? sql`AND runs."branch" = ${branch}` : sql``;
  const { rows } = await sql<{
    testId: string;
    status: string;
    title: string;
    file: string;
    rn: number;
  }>`
    SELECT "testId", "status", "title", "file", "rn"
    FROM (
      SELECT
        "testResults"."testId" AS "testId",
        "testResults"."status" AS "status",
        "testResults"."title" AS "title",
        "testResults"."file" AS "file",
        row_number() OVER (
          PARTITION BY "testResults"."testId"
          ORDER BY "testResults"."createdAt" DESC
        ) AS "rn"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${projectId}
        AND "runs"."committed" = 1
        AND "testResults"."testId" IN (${sql.join(testIds)})
        ${branchClause}
    )
    WHERE "rn" <= ${SPARKLINE_SIZE}
    ORDER BY "testId", "rn" DESC
  `.execute(db);

  for (const r of rows) {
    let entry = out.get(r.testId);
    if (!entry) {
      entry = { sparkline: [], title: r.title, file: r.file };
      out.set(r.testId, entry);
    }
    // Rows arrive oldest → newest within a testId (rn DESC). Latest row
    // (rn === 1) wins for the displayed title/file.
    if (r.rn === 1) {
      entry.title = r.title;
      entry.file = r.file;
    }
    entry.sparkline.push({ status: r.status });
  }
  return out;
}

interface RecentFailureRow {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
}

async function loadRecentFailures(
  db: Kysely<TenantDatabase>,
  projectId: string,
  testIds: string[],
  branch: string | null,
): Promise<Map<string, RecentFailureRow[]>> {
  const out = new Map<string, RecentFailureRow[]>();
  if (testIds.length === 0) return out;

  const branchClause = branch ? sql`AND runs."branch" = ${branch}` : sql``;
  const { rows } = await sql<RecentFailureRow & { testId: string; rn: number }>`
    SELECT
      "testId", "testResultId", "runId", "commitSha", "branch",
      "createdAt", "errorMessage", "errorStack"
    FROM (
      SELECT
        "testResults"."testId" AS "testId",
        "testResults"."id" AS "testResultId",
        "testResults"."runId" AS "runId",
        "testResults"."createdAt" AS "createdAt",
        "testResults"."errorMessage" AS "errorMessage",
        "testResults"."errorStack" AS "errorStack",
        "runs"."commitSha" AS "commitSha",
        "runs"."branch" AS "branch",
        row_number() OVER (
          PARTITION BY "testResults"."testId"
          ORDER BY "testResults"."createdAt" DESC
        ) AS "rn"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${projectId}
        AND "runs"."committed" = 1
        AND "testResults"."testId" IN (${sql.join(testIds)})
        AND "testResults"."status" IN ('flaky', 'failed', 'timedout')
        ${branchClause}
    )
    WHERE "rn" <= ${RECENT_FAILURES}
    ORDER BY "testId", "rn" ASC
  `.execute(db);

  for (const r of rows) {
    let entry = out.get(r.testId);
    if (!entry) {
      entry = [];
      out.set(r.testId, entry);
    }
    entry.push({
      testResultId: r.testResultId,
      runId: r.runId,
      commitSha: r.commitSha,
      branch: r.branch,
      createdAt: r.createdAt,
      errorMessage: r.errorMessage,
      errorStack: r.errorStack,
    });
  }
  return out;
}
