import { sql } from "kysely";
import { getTenantDb } from "../internal";
import type { TenantScope } from "../index";

export interface SlowestTestsFilters {
  windowStartSec: number;
  branch: string | null;
  q: string;
}

export interface HistogramRow {
  bin: number;
  cnt: number;
}

export interface BottleneckRow {
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

export interface SparklinePoint {
  day: number;
  avg: number;
}

const DAY_SEC = 86_400;
const SPARKLINE_DAYS = 7;

/**
 * Total `testResults` rows + max duration + distinct test count, all
 * filtered by the slowest-tests page filters. Joins runs because the
 * branch filter is on `runs`, not on testResults.
 */
export async function loadSlowestTestsTotals(
  scope: TenantScope,
  filters: SlowestTestsFilters,
): Promise<{
  totalResults: number;
  maxDurationMs: number;
  totalUniqueTests: number;
}> {
  const pattern = filters.q ? `%${filters.q}%` : null;

  const baseTotals = scope
    .from("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("testResults.createdAt", ">=", filters.windowStartSec)
    .where("testResults.status", "!=", "skipped")
    .$if(!!filters.branch, (qb) =>
      qb.where("runs.branch", "=", filters.branch ?? ""),
    )
    .$if(!!pattern, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb("testResults.title", "like", pattern ?? ""),
          eb("testResults.file", "like", pattern ?? ""),
        ]),
      ),
    );

  const [totalsRow, distinctRow] = await Promise.all([
    baseTotals
      .select((eb) => [
        eb.fn.max("testResults.durationMs").as("maxDur"),
        eb.fn.countAll<number>().as("n"),
      ])
      .executeTakeFirst(),
    baseTotals
      .select((eb) =>
        eb.fn.count<number>("testResults.testId").distinct().as("n"),
      )
      .executeTakeFirst(),
  ]);

  return {
    totalResults: totalsRow?.n ?? 0,
    maxDurationMs: totalsRow?.maxDur ?? 0,
    totalUniqueTests: distinctRow?.n ?? 0,
  };
}

/** Histogram of testResults durations bucketed into N bins of `bucketMs` ms. */
export async function loadSlowestTestsHistogram(
  scope: TenantScope,
  filters: SlowestTestsFilters,
  bucketMs: number,
  bins: number,
): Promise<HistogramRow[]> {
  const topBin = bins - 1;
  const pattern = filters.q ? `%${filters.q}%` : null;
  // Bin width inlined as SQL literals via `sql.raw` — the DO-SQLite driver
  // binds params with text affinity, so `/ ${bucketMs}` would silently turn
  // integer division into string concatenation and return one huge bin.
  const binExpr = sql<number>`CAST(
    CASE
      WHEN "testResults"."durationMs" >= ${sql.raw(String(bucketMs * bins))}
      THEN ${sql.raw(String(topBin))}
      ELSE "testResults"."durationMs" / ${sql.raw(String(bucketMs))}
    END AS INTEGER
  )`;

  return scope
    .from("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("testResults.createdAt", ">=", filters.windowStartSec)
    .where("testResults.status", "!=", "skipped")
    .$if(!!filters.branch, (qb) =>
      qb.where("runs.branch", "=", filters.branch ?? ""),
    )
    .$if(!!pattern, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb("testResults.title", "like", pattern ?? ""),
          eb("testResults.file", "like", pattern ?? ""),
        ]),
      ),
    )
    .select((eb) => [binExpr.as("bin"), eb.fn.countAll<number>().as("cnt")])
    .groupBy(binExpr)
    .execute();
}

/**
 * Paginated bottleneck rows. Window functions compute a duration-sorted
 * rank (for p95) and a time-sorted rank (to pick the latest title /
 * file / status). Returns at most `limit` rows; ranking happens inside
 * SQLite, not in the Worker.
 *
 * Discrete percentile: rank `MAX(1, ROUND(cnt * 0.95))` keeps the target
 * in [1..cnt] so a single-run testId resolves p95 to its only sample
 * instead of rank 0 (no such row).
 */
export async function loadSlowestTestsBottlenecks(
  scope: TenantScope,
  filters: SlowestTestsFilters,
  limit: number,
  offset: number,
): Promise<BottleneckRow[]> {
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;
  const pattern = filters.q ? `%${filters.q}%` : null;

  return db
    .with("filtered", (eb) =>
      eb
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .where("testResults.projectId", "=", projectId)
        .where("testResults.createdAt", ">=", filters.windowStartSec)
        .where("testResults.status", "!=", "skipped")
        .$if(!!filters.branch, (qb) =>
          qb.where("runs.branch", "=", filters.branch ?? ""),
        )
        .$if(!!pattern, (qb) =>
          qb.where((eb2) =>
            eb2.or([
              eb2("testResults.title", "like", pattern ?? ""),
              eb2("testResults.file", "like", pattern ?? ""),
            ]),
          ),
        )
        .select([
          "testResults.testId as testId",
          "testResults.durationMs as durationMs",
          "testResults.title as title",
          "testResults.file as file",
          "testResults.status as status",
          "testResults.createdAt as createdAt",
          "testResults.runId as runId",
          "testResults.id as testResultId",
        ]),
    )
    .with("ranked", (eb) =>
      eb.selectFrom("filtered").select((eb2) => [
        "testId",
        "durationMs",
        "title",
        "file",
        "status",
        "createdAt",
        "runId",
        "testResultId",
        eb2.fn
          .agg<number>("row_number")
          .over((o) => o.partitionBy("testId").orderBy("durationMs"))
          .as("rnDur"),
        eb2.fn
          .agg<number>("row_number")
          .over((o) => o.partitionBy("testId").orderBy("createdAt", "desc"))
          .as("rnTime"),
        eb2.fn
          .countAll<number>()
          .over((o) => o.partitionBy("testId"))
          .as("cnt"),
      ]),
    )
    .selectFrom("ranked")
    .select((eb) => [
      "testId",
      eb.fn.max<number>("cnt").as("n"),
      eb.fn.avg<number | null>("durationMs").as("avgDur"),
      sql<
        number | null
      >`MIN(CASE WHEN "rnDur" = MAX(1, CAST(ROUND("cnt" * 0.95) AS INTEGER)) THEN "durationMs" END)`.as(
        "p95",
      ),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "title" END)`.as(
        "title",
      ),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "file" END)`.as(
        "file",
      ),
      sql<string | null>`MAX(CASE WHEN "rnTime" = 1 THEN "runId" END)`.as(
        "latestRunId",
      ),
      sql<
        string | null
      >`MAX(CASE WHEN "rnTime" = 1 THEN "testResultId" END)`.as(
        "latestTestResultId",
      ),
      sql<number>`SUM(CASE WHEN "status" IN ('failed', 'timedout') THEN 1 ELSE 0 END)`.as(
        "failCount",
      ),
      sql<number>`SUM(CASE WHEN "status" = 'flaky' THEN 1 ELSE 0 END)`.as(
        "flakyCount",
      ),
    ])
    .groupBy("testId")
    .orderBy("p95", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

/**
 * Daily-avg sparkline data for the supplied testIds, always over the
 * trailing 7 days. Day bucket uses a literal divisor for the same
 * DO-SQLite text-affinity reason documented in analytics/bucketing.ts.
 */
export async function loadSlowestTestsSparklines(
  scope: TenantScope,
  testIds: readonly string[],
  branch: string | null,
  nowSec: number,
): Promise<Map<string, SparklinePoint[]>> {
  const out = new Map<string, SparklinePoint[]>();
  if (testIds.length === 0) return out;
  const sparkStart = nowSec - SPARKLINE_DAYS * DAY_SEC;
  const dayExpr = sql<number>`CAST("testResults"."createdAt" / 86400 AS INTEGER)`;

  const rows = await scope
    .from("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("testResults.createdAt", ">=", sparkStart)
    .where("testResults.status", "!=", "skipped")
    .where("testResults.testId", "in", testIds)
    .$if(!!branch, (qb) => qb.where("runs.branch", "=", branch ?? ""))
    .select((eb) => [
      "testResults.testId as testId",
      dayExpr.as("day"),
      eb.fn.avg<number>("testResults.durationMs").as("avg"),
    ])
    .groupBy(["testResults.testId", dayExpr])
    .orderBy("testResults.testId", "asc")
    .orderBy("day", "asc")
    .execute();

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
