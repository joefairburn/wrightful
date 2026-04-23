import { type Kysely, sql } from "kysely";
import { requestInfo } from "rwsdk/worker";
import { FlakyTestRow } from "@/app/components/flaky-test-row";
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
  if (!branchAll) agg = agg.where("runs.branch", "=", branchParam);

  const aggregates = await agg
    .select([
      "testResults.testId as testId",
      sql<string>`max(testResults.title)`.as("title"),
      sql<string>`max(testResults.file)`.as("file"),
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

  const ranked = aggregates
    .map((r) => {
      const denom = r.flakyCount + r.passedCount;
      const pct = denom === 0 ? 0 : (r.flakyCount / denom) * 100;
      return { ...r, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.flakyCount - a.flakyCount)
    .slice(0, TOP_N);

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

  // Load sparkline points + recent failures per top testId in parallel.
  const testIds = ranked.map((r) => r.testId);
  const [sparkByTest, failsByTest] = await Promise.all([
    loadSparklines(
      tenantDb,
      project.id,
      testIds,
      branchAll ? null : branchParam,
    ),
    loadRecentFailures(
      tenantDb,
      project.id,
      testIds,
      branchAll ? null : branchParam,
    ),
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
            {ranked.length} Flaky Test{ranked.length === 1 ? "" : "s"}
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            Tests exhibiting unstable behavior across recent CI runs.
          </p>
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
                    title={row.title}
                    file={row.file}
                    total={row.total}
                    flakyCount={row.flakyCount}
                    pct={row.pct}
                    sparklinePoints={sparkByTest.get(row.testId) ?? []}
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

async function loadSparklines(
  db: Kysely<TenantDatabase>,
  projectId: string,
  testIds: string[],
  branch: string | null,
): Promise<Map<string, { status: string }[]>> {
  const out = new Map<string, { status: string }[]>();
  if (testIds.length === 0) return out;

  await Promise.all(
    testIds.map(async (testId) => {
      let q = db
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .select([
          "testResults.status as status",
          "testResults.createdAt as createdAt",
        ])
        .where("runs.projectId", "=", projectId)
        .where("runs.committed", "=", 1)
        .where("testResults.testId", "=", testId);
      if (branch) q = q.where("runs.branch", "=", branch);
      const rows = await q
        .orderBy("testResults.createdAt", "desc")
        .limit(SPARKLINE_SIZE)
        .execute();
      out.set(
        testId,
        rows
          .slice()
          .reverse()
          .map((r) => ({ status: r.status })),
      );
    }),
  );
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

  await Promise.all(
    testIds.map(async (testId) => {
      let q = db
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .select([
          "testResults.id as testResultId",
          "testResults.runId as runId",
          "testResults.createdAt as createdAt",
          "testResults.errorMessage as errorMessage",
          "testResults.errorStack as errorStack",
          "runs.commitSha as commitSha",
          "runs.branch as branch",
        ])
        .where("runs.projectId", "=", projectId)
        .where("runs.committed", "=", 1)
        .where("testResults.testId", "=", testId)
        .where("testResults.status", "in", ["flaky", "failed", "timedout"]);
      if (branch) q = q.where("runs.branch", "=", branch);
      const rows = await q
        .orderBy("testResults.createdAt", "desc")
        .limit(RECENT_FAILURES)
        .execute();
      out.set(testId, rows);
    }),
  );
  return out;
}
