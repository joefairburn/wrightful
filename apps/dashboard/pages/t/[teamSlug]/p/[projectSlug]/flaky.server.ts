import { defineHandler, type InferProps } from "void";
import { and, db, eq, gte, inArray, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import { parseBranchParam } from "@/components/run-history-branch-filter.shared";
import { branchFragment, branchJoinFragment } from "@/lib/analytics/filters";
import { loadProjectBranches } from "@/lib/branches-query";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const TOP_N = 50;
const SPARKLINE_SIZE = 20;
const RECENT_FAILURES = 3;

type RangeKey = "7d" | "14d" | "30d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d"];
const DEFAULT_RANGE: RangeKey = "14d";

function parseRange(value: string | null): RangeKey {
  if (value === "7d" || value === "14d" || value === "30d") return value;
  return DEFAULT_RANGE;
}

function rangeToDays(r: RangeKey): number {
  return r === "7d" ? 7 : r === "14d" ? 14 : 30;
}

export interface RankedTest {
  testId: string;
  total: number;
  flakyCount: number;
  passedCount: number;
  pct: number;
}

export interface FlakyTestMeta {
  title: string;
  file: string;
  tags: string[];
  sparkline: { status: string }[];
}

export interface RecentFailureRow {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  actor: string | null;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
}

/**
 * Flaky tests loader. Three serial passes:
 *  1. Aggregate per testId across the window — flakyCount / passedCount /
 *     total. Filter to tests that have at least one flaky result.
 *  2. Sparkline (last 20 statuses) + latest title/file for the page slice.
 *  3. Recent failures (last 3 flaky/failed/timedout) per testId.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const branchParam = url.searchParams.get("branch");
  const branchFilter = parseBranchParam(branchParam);
  const branchAll = branchFilter === null;

  const windowStartSec =
    Math.floor(Date.now() / 1000) - rangeToDays(range) * 24 * 60 * 60;

  const branches = await loadProjectBranches(scope);

  // 1. Aggregates.
  const aggConditions = [
    eq(testResults.projectId, scope.projectId),
    gte(testResults.createdAt, windowStartSec),
  ];
  if (branchFilter) aggConditions.push(eq(runs.branch, branchFilter));

  const aggRows = await db
    .select({
      testId: testResults.testId,
      total: sql<number>`sum(case when ${testResults.status} != 'skipped' then 1 else 0 end)`,
      flakyCount: sql<number>`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end)`,
      passedCount: sql<number>`sum(case when ${testResults.status} = 'passed' then 1 else 0 end)`,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(and(...aggConditions))
    .groupBy(testResults.testId)
    .having(
      sql`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end) >= 1`,
    );

  const rankedAll: RankedTest[] = aggRows
    .map((r) => {
      const denom = r.flakyCount + r.passedCount;
      const pct = denom === 0 ? 0 : (r.flakyCount / denom) * 100;
      return { ...r, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.flakyCount - a.flakyCount);

  const totalFlakyTests = rankedAll.length;
  const ranked = rankedAll.slice(0, TOP_N);
  const truncated = totalFlakyTests > ranked.length;
  const testIds = ranked.map((r) => r.testId);

  // 2 + 3 in parallel.
  const sparkByTest = new Map<string, FlakyTestMeta>();
  const failsByTest = new Map<string, RecentFailureRow[]>();

  if (testIds.length > 0) {
    const [sparkRows, failRows, tagRows] = await Promise.all([
      loadSparklinesAndMeta(
        scope.projectId,
        testIds,
        branchFilter,
        SPARKLINE_SIZE,
      ),
      loadRecentFailures(
        scope.projectId,
        testIds,
        branchFilter,
        RECENT_FAILURES,
      ),
      loadTagsByTestId(scope.projectId, testIds),
    ]);
    for (const r of sparkRows) {
      let entry = sparkByTest.get(r.testId);
      if (!entry) {
        entry = { sparkline: [], title: r.title, file: r.file, tags: [] };
        sparkByTest.set(r.testId, entry);
      }
      if (r.rn === 1) {
        entry.title = r.title;
        entry.file = r.file;
      }
      entry.sparkline.push({ status: r.status });
    }
    for (const r of tagRows) {
      const entry = sparkByTest.get(r.testId);
      if (entry && !entry.tags.includes(r.tag)) {
        entry.tags.push(r.tag);
      }
    }
    for (const r of failRows) {
      let entry = failsByTest.get(r.testId);
      if (!entry) {
        entry = [];
        failsByTest.set(r.testId, entry);
      }
      entry.push({
        testResultId: r.testResultId,
        runId: r.runId,
        commitSha: r.commitSha,
        branch: r.branch,
        actor: r.actor,
        createdAt: r.createdAt,
        errorMessage: r.errorMessage,
        errorStack: r.errorStack,
      });
    }
  }

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    range,
    branchParam,
    branchAll,
    branchFilter,
    branches,
    rangeDays: rangeToDays(range),
    totalFlakyTests,
    truncated,
    ranked,
    // Convert maps to plain objects for serialization.
    sparkByTest: Object.fromEntries(sparkByTest),
    failsByTest: Object.fromEntries(failsByTest),
    pathname: url.pathname,
    ranges: RANGES,
  };
});

interface SparklineMetaRow {
  testId: string;
  status: string;
  title: string;
  file: string;
  rn: number;
}

/**
 * Per-test sparkline + latest title/file using a row_number() CTE.
 * Drizzle doesn't have a typed CTE builder, so this is a single raw-SQL
 * query that returns the same shape the rwsdk version produced.
 */
async function loadSparklinesAndMeta(
  projectId: string,
  testIds: readonly string[],
  branch: string | null,
  sparklineSize: number,
): Promise<SparklineMetaRow[]> {
  const branchSql = branchFragment(branch);
  const joinSql = branchJoinFragment(branch);

  const result = await db.run(sql`
    with ranked as (
      select
        tr."testId" as "testId",
        tr.status as status,
        tr.title as title,
        tr.file as file,
        row_number() over (
          partition by tr."testId"
          order by tr."createdAt" desc
        ) as rn
      from "testResults" tr
      ${joinSql}
      where tr."projectId" = ${projectId}
        and tr."testId" in (${sql.join(
          testIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ${branchSql}
    )
    select "testId", status, title, file, rn
    from ranked
    where rn <= ${sparklineSize}
    order by "testId" asc, rn desc
  `);

  return (result.results as SparklineMetaRow[]) ?? [];
}

interface RecentFailureSqlRow {
  testId: string;
  testResultId: string;
  runId: string;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
  commitSha: string | null;
  branch: string | null;
  actor: string | null;
  rn: number;
}

async function loadRecentFailures(
  projectId: string,
  testIds: readonly string[],
  branch: string | null,
  count: number,
): Promise<RecentFailureSqlRow[]> {
  const branchSql = branchFragment(branch);

  const result = await db.run(sql`
    with ranked as (
      select
        tr."testId" as "testId",
        tr.id as "testResultId",
        tr."runId" as "runId",
        tr."createdAt" as "createdAt",
        tr."errorMessage" as "errorMessage",
        tr."errorStack" as "errorStack",
        runs."commitSha" as "commitSha",
        runs.branch as branch,
        runs.actor as actor,
        row_number() over (
          partition by tr."testId"
          order by tr."createdAt" desc
        ) as rn
      from "testResults" tr
      inner join runs on runs.id = tr."runId"
      where tr."projectId" = ${projectId}
        and tr."testId" in (${sql.join(
          testIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        and tr.status in ('flaky', 'failed', 'timedout')
        ${branchSql}
    )
    select "testId", "testResultId", "runId", "createdAt",
           "errorMessage", "errorStack", "commitSha", branch, actor, rn
    from ranked
    where rn <= ${count}
    order by "testId" asc, rn asc
  `);

  // Silence unused-import warnings — `inArray` would be the Drizzle equivalent
  // of the `testId in (...)` clause if we weren't going through `sql.join`.
  void inArray;

  return (result.results as RecentFailureSqlRow[]) ?? [];
}

interface TagRow {
  testId: string;
  tag: string;
}

/**
 * Distinct (testId, tag) pairs for the requested testIds. Tags hang off
 * `testResults` rows (one row per attempt) but are stable per testId in
 * practice, so we dedupe across all attempts and surface the set.
 */
async function loadTagsByTestId(
  projectId: string,
  testIds: readonly string[],
): Promise<TagRow[]> {
  const result = await db.run(sql`
    select distinct tr."testId" as "testId", tt.tag as tag
    from ${testTags} tt
    inner join ${testResults} tr on tr.id = tt."testResultId"
    where tr."projectId" = ${projectId}
      and tr."testId" in (${sql.join(
        testIds.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);

  return (result.results as TagRow[]) ?? [];
}
