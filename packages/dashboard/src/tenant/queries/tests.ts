import { sql } from "kysely";
import { getTenantDb } from "../internal";
import type { TenantScope } from "../index";

export interface TestsPageRow {
  testId: string;
  title: string;
  file: string;
  latestStatus: string;
  latestRunId: string | null;
  latestTestResultId: string | null;
  lastSeen: number;
  n: number;
  avgDurationMs: number | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

export interface TestsPageData {
  rows: TestsPageRow[];
  totalUniqueTests: number;
  currentPage: number;
  totalPages: number;
  fromRow: number;
  toRow: number;
}

export interface LoadTestsPageOpts {
  windowStartSec: number;
  branch: string | null;
  q: string;
  requestedPage: number;
  pageSize: number;
}

interface PageRow {
  testId: string;
  lastSeen: number;
  totalDistinct: number;
}

/**
 * Test catalog page query. Two passes:
 *
 *  1. Page query — paginate testIds by lastSeen DESC, with a windowed
 *     `count(*) OVER ()` so we don't need a second round trip just for
 *     pagination math.
 *  2. Aggregate query — fill in per-test aggregates only for the current
 *     page's testIds, so work is bounded by ~PAGE_SIZE testIds × occurrences.
 *
 * Filter is on `runs.createdAt` (not `testResults.createdAt`) so the
 * planner can use the `runs (projectId, createdAt)` index. The two
 * timestamps are within milliseconds of each other in practice — they
 * differ only by the test runtime — so the result set is functionally
 * identical.
 */
export async function loadTestsPageData(
  scope: TenantScope,
  opts: LoadTestsPageOpts,
): Promise<TestsPageData> {
  const offset = (opts.requestedPage - 1) * opts.pageSize;
  const pageRows = await runPageQuery(scope, opts, offset);

  const totalUniqueTests = pageRows[0]?.totalDistinct ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalUniqueTests / opts.pageSize));

  // Out-of-range page (manual URL edit, deleted runs, etc): clamp to last
  // page and re-fetch. Uncommon; one extra round trip is fine.
  let rowsForPage = pageRows;
  let currentPage = opts.requestedPage;
  if (
    rowsForPage.length === 0 &&
    totalUniqueTests > 0 &&
    opts.requestedPage > 1
  ) {
    currentPage = totalPages;
    const reOffset = (currentPage - 1) * opts.pageSize;
    rowsForPage = await runPageQuery(scope, opts, reOffset);
  } else {
    currentPage = Math.min(opts.requestedPage, totalPages);
  }

  if (rowsForPage.length === 0) {
    return {
      rows: [],
      totalUniqueTests,
      currentPage,
      totalPages,
      fromRow: 0,
      toRow: 0,
    };
  }

  const lastSeenById = new Map(rowsForPage.map((r) => [r.testId, r.lastSeen]));
  const testIds = rowsForPage.map((r) => r.testId);
  const aggById = await runAggregateQuery(scope, opts, testIds);

  // Preserve the lastSeen DESC ordering from page query — the IN-list
  // doesn't preserve order.
  const rows: TestsPageRow[] = testIds.flatMap((id) => {
    const a = aggById.get(id);
    const lastSeen = lastSeenById.get(id) ?? 0;
    if (!a) return [];
    return [
      {
        testId: id,
        title: a.title ?? "",
        file: a.file ?? "",
        latestStatus: a.latestStatus ?? "",
        latestRunId: a.latestRunId,
        latestTestResultId: a.latestTestResultId,
        lastSeen,
        n: a.n,
        avgDurationMs: a.avgDurationMs,
        passedCount: a.passedCount,
        flakyCount: a.flakyCount,
        failCount: a.failCount,
        skippedCount: a.skippedCount,
      },
    ];
  });

  const fromRow =
    totalUniqueTests === 0 ? 0 : (currentPage - 1) * opts.pageSize + 1;
  const toRow = (currentPage - 1) * opts.pageSize + rows.length;

  return {
    rows,
    totalUniqueTests,
    currentPage,
    totalPages,
    fromRow,
    toRow,
  };
}

async function runPageQuery(
  scope: TenantScope,
  opts: LoadTestsPageOpts,
  offset: number,
): Promise<PageRow[]> {
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;
  const pattern = opts.q ? `%${opts.q}%` : null;

  // LIMIT/OFFSET inlined as raw — DO-SQLite's text-affinity binding turns
  // numeric params into strings here, which would coerce LIMIT to 0.
  return db
    .with("grouped", (eb) =>
      eb
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .where("testResults.projectId", "=", projectId)
        .where("runs.createdAt", ">=", opts.windowStartSec)
        .$if(!!opts.branch, (qb) =>
          qb.where("runs.branch", "=", opts.branch ?? ""),
        )
        .$if(!!pattern, (qb) =>
          qb.where((eb2) =>
            eb2.or([
              eb2("testResults.title", "like", pattern ?? ""),
              eb2("testResults.file", "like", pattern ?? ""),
            ]),
          ),
        )
        .select((eb2) => [
          "testResults.testId as testId",
          eb2.fn.max<number>("testResults.createdAt").as("lastSeen"),
          eb2.fn.countAll<number>().over().as("totalDistinct"),
        ])
        .groupBy("testResults.testId"),
    )
    .selectFrom("grouped")
    .select(["testId", "lastSeen", "totalDistinct"])
    .orderBy("lastSeen", "desc")
    .limit(sql.raw(String(opts.pageSize)))
    .offset(sql.raw(String(offset)))
    .execute();
}

interface AggregateRow {
  testId: string;
  n: number;
  avgDurationMs: number | null;
  title: string | null;
  file: string | null;
  latestStatus: string | null;
  latestRunId: string | null;
  latestTestResultId: string | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

async function runAggregateQuery(
  scope: TenantScope,
  opts: LoadTestsPageOpts,
  testIds: readonly string[],
): Promise<Map<string, AggregateRow>> {
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;

  const rows = await db
    .with("ranked", (eb) =>
      eb
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .where("testResults.projectId", "=", projectId)
        .where("runs.createdAt", ">=", opts.windowStartSec)
        .where("testResults.testId", "in", testIds)
        .$if(!!opts.branch, (qb) =>
          qb.where("runs.branch", "=", opts.branch ?? ""),
        )
        .select((eb2) => [
          "testResults.testId as testId",
          "testResults.title as title",
          "testResults.file as file",
          "testResults.status as status",
          "testResults.durationMs as durationMs",
          "testResults.createdAt as createdAt",
          "testResults.runId as runId",
          "testResults.id as testResultId",
          eb2.fn
            .agg<number>("row_number")
            .over((o) =>
              o
                .partitionBy("testResults.testId")
                .orderBy("testResults.createdAt", "desc"),
            )
            .as("rnTime"),
        ]),
    )
    .selectFrom("ranked")
    .select((eb) => [
      "testId",
      eb.fn.countAll<number>().as("n"),
      eb.fn.avg<number | null>("durationMs").as("avgDurationMs"),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "title" END)`.as(
        "title",
      ),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "file" END)`.as(
        "file",
      ),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "status" END)`.as(
        "latestStatus",
      ),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "runId" END)`.as(
        "latestRunId",
      ),
      sql<
        string | null
      >`MAX(CASE WHEN "rnTime" = 1 THEN "testResultId" END)`.as(
        "latestTestResultId",
      ),
      sql<number>`SUM(CASE WHEN "status" = 'passed' THEN 1 ELSE 0 END)`.as(
        "passedCount",
      ),
      sql<number>`SUM(CASE WHEN "status" = 'flaky' THEN 1 ELSE 0 END)`.as(
        "flakyCount",
      ),
      sql<number>`SUM(CASE WHEN "status" IN ('failed', 'timedout') THEN 1 ELSE 0 END)`.as(
        "failCount",
      ),
      sql<number>`SUM(CASE WHEN "status" = 'skipped' THEN 1 ELSE 0 END)`.as(
        "skippedCount",
      ),
    ])
    .groupBy("testId")
    .execute();

  return new Map(rows.map((r) => [r.testId, r]));
}
