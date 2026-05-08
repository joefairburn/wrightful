import { sql } from "kysely";
import { getTenantDb } from "../internal";
import type { TenantScope } from "../index";

export interface FlakyAggregate {
  testId: string;
  total: number;
  flakyCount: number;
  passedCount: number;
}

export interface FlakyTestMeta {
  sparkline: { status: string }[];
  title: string;
  file: string;
}

export interface RecentFailureRow {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
}

/**
 * Aggregate per testId across the window. Returns one row per testId that
 * has at least one flaky result; total = non-skipped runs, flakyCount and
 * passedCount feed the flakiness percentage in the page.
 */
export async function loadFlakyAggregates(
  scope: TenantScope,
  windowStartSec: number,
  branch: string | null,
): Promise<FlakyAggregate[]> {
  const flakyCountExpr = sql<number>`sum(case when "testResults"."status" = 'flaky' then 1 else 0 end)`;
  let q = scope
    .from("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .where("testResults.createdAt", ">=", windowStartSec)
    .select([
      "testResults.testId as testId",
      sql<number>`sum(case when "testResults"."status" != 'skipped' then 1 else 0 end)`.as(
        "total",
      ),
      flakyCountExpr.as("flakyCount"),
      sql<number>`sum(case when "testResults"."status" = 'passed' then 1 else 0 end)`.as(
        "passedCount",
      ),
    ])
    .groupBy("testResults.testId")
    .having(flakyCountExpr, ">=", 1);
  if (branch) q = q.where("runs.branch", "=", branch);
  return q.execute();
}

/** Sparkline + latest title/file for the supplied testIds. */
export async function loadFlakySparklinesAndMeta(
  scope: TenantScope,
  testIds: readonly string[],
  branch: string | null,
  sparklineSize: number,
): Promise<Map<string, FlakyTestMeta>> {
  const out = new Map<string, FlakyTestMeta>();
  if (testIds.length === 0) return out;
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;

  const rows = await db
    .with("ranked", (eb) => {
      let inner = eb
        .selectFrom("testResults")
        .where("testResults.projectId", "=", projectId)
        .where("testResults.testId", "in", testIds)
        .select((eb2) => [
          "testResults.testId as testId",
          "testResults.status as status",
          "testResults.title as title",
          "testResults.file as file",
          eb2.fn
            .agg<number>("row_number")
            .over((o) =>
              o
                .partitionBy("testResults.testId")
                .orderBy("testResults.createdAt", "desc"),
            )
            .as("rn"),
        ]);
      if (branch) {
        inner = inner
          .innerJoin("runs", "runs.id", "testResults.runId")
          .where("runs.branch", "=", branch);
      }
      return inner;
    })
    .selectFrom("ranked")
    .select(["testId", "status", "title", "file", "rn"])
    .where("rn", "<=", sparklineSize)
    .orderBy("testId", "asc")
    .orderBy("rn", "desc")
    .execute();

  for (const r of rows) {
    let entry = out.get(r.testId);
    if (!entry) {
      entry = { sparkline: [], title: r.title, file: r.file };
      out.set(r.testId, entry);
    }
    if (r.rn === 1) {
      entry.title = r.title;
      entry.file = r.file;
    }
    entry.sparkline.push({ status: r.status });
  }
  return out;
}

/** Last `count` failures (flaky / failed / timedout) per testId. */
export async function loadFlakyRecentFailures(
  scope: TenantScope,
  testIds: readonly string[],
  branch: string | null,
  count: number,
): Promise<Map<string, RecentFailureRow[]>> {
  const out = new Map<string, RecentFailureRow[]>();
  if (testIds.length === 0) return out;
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;

  const rows = await db
    .with("ranked", (eb) => {
      let inner = eb
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .where("testResults.projectId", "=", projectId)
        .where("testResults.testId", "in", testIds)
        .where("testResults.status", "in", ["flaky", "failed", "timedout"])
        .select((eb2) => [
          "testResults.testId as testId",
          "testResults.id as testResultId",
          "testResults.runId as runId",
          "testResults.createdAt as createdAt",
          "testResults.errorMessage as errorMessage",
          "testResults.errorStack as errorStack",
          "runs.commitSha as commitSha",
          "runs.branch as branch",
          eb2.fn
            .agg<number>("row_number")
            .over((o) =>
              o
                .partitionBy("testResults.testId")
                .orderBy("testResults.createdAt", "desc"),
            )
            .as("rn"),
        ]);
      if (branch) inner = inner.where("runs.branch", "=", branch);
      return inner;
    })
    .selectFrom("ranked")
    .select([
      "testId",
      "testResultId",
      "runId",
      "createdAt",
      "errorMessage",
      "errorStack",
      "commitSha",
      "branch",
      "rn",
    ])
    .where("rn", "<=", count)
    .orderBy("testId", "asc")
    .orderBy("rn", "asc")
    .execute();

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
