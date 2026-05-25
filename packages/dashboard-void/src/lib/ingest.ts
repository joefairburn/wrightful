import { ulid } from "ulid";
import { and, db, eq, inArray, sql } from "void/db";
import {
  runs,
  testAnnotations,
  testResultAttempts,
  testResults,
  testTags,
  teams,
} from "@schema";
import type { TenantScope } from "@/lib/scope";
import type { TestResultInput } from "@/lib/schemas";
import {
  publishRunUpdate,
  type RunProgressEvent,
  type RunProgressTest,
} from "@/live";

/** Columns published in every `RunProgressEvent.summary`. */
export const AGGREGATE_SUMMARY_COLUMNS = {
  totalTests: runs.totalTests,
  passed: runs.passed,
  failed: runs.failed,
  flaky: runs.flaky,
  skipped: runs.skipped,
  durationMs: runs.durationMs,
  status: runs.status,
  completedAt: runs.completedAt,
} as const;

export type RunAggregateSummary = RunProgressEvent["summary"];

/**
 * Drizzle/D1 port of the rwsdk ingest pipeline. Same shape, same atomicity
 * guarantees (D1 `batch` runs every statement inside a single transaction
 * on the writer node).
 *
 * Notable differences from the DO version:
 *   - One D1 instead of per-team DO; every write carries `teamId AND projectId`.
 *   - `db.batch` is the atomicity boundary (Drizzle wraps D1's batch API).
 *   - Realtime broadcasts go through `void/live` topic `run:<runId>` not a
 *     stateful SyncedStateServer room.
 */

// D1 caps the parameter count per statement at 100. Match the previous DO
// cadence (99) so chunk sizes stay identical.
const MAX_PARAMS_PER_STATEMENT = 99;
const TEST_RESULTS_COLUMNS = 14;
const TEST_TAGS_COLUMNS = 4;
const TEST_ANNOTATIONS_COLUMNS = 5;
const TEST_RESULT_ATTEMPTS_COLUMNS = 9;

export function chunkByParams<T>(rows: T[], columnsPerRow: number): T[][] {
  const rowsPerStatement = Math.max(
    1,
    Math.floor(MAX_PARAMS_PER_STATEMENT / columnsPerRow),
  );
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    chunks.push(rows.slice(i, i + rowsPerStatement));
  }
  return chunks;
}

export interface ResultMapping {
  clientKey: string;
  testResultId: string;
}

export async function resolveTestResultIds(
  scope: TenantScope,
  runId: string,
  testIds: string[],
): Promise<{
  existingIds: Map<string, string>;
  assignedIds: Map<string, string>;
  prevStatusByTestId: Map<string, string>;
}> {
  const existingIds = new Map<string, string>();
  const prevStatusByTestId = new Map<string, string>();
  if (testIds.length > 0) {
    const rows = await db
      .select({
        id: testResults.id,
        testId: testResults.testId,
        status: testResults.status,
      })
      .from(testResults)
      .where(
        and(
          eq(testResults.projectId, scope.projectId),
          eq(testResults.runId, runId),
          inArray(testResults.testId, testIds),
        ),
      );
    for (const row of rows) {
      existingIds.set(row.testId, row.id);
      prevStatusByTestId.set(row.testId, row.status);
    }
  }
  const assignedIds = new Map<string, string>();
  for (const testId of testIds) {
    assignedIds.set(testId, existingIds.get(testId) ?? ulid());
  }
  return { existingIds, assignedIds, prevStatusByTestId };
}

export function buildQueuePrefillStatements(
  scope: TenantScope,
  runId: string,
  plannedTests: ReadonlyArray<{
    testId: string;
    title: string;
    file: string;
    projectName?: string | null | undefined;
  }>,
  nowSeconds: number,
) {
  if (plannedTests.length === 0) return [];
  const rows = plannedTests.map((p) => ({
    id: ulid(),
    projectId: scope.projectId,
    runId,
    testId: p.testId,
    title: p.title,
    file: p.file,
    projectName: p.projectName ?? null,
    status: "queued",
    durationMs: 0,
    retryCount: 0,
    errorMessage: null,
    errorStack: null,
    workerIndex: null,
    createdAt: nowSeconds,
  }));
  return chunkByParams(rows, TEST_RESULTS_COLUMNS).map((chunk) =>
    db.insert(testResults).values(chunk),
  );
}

/**
 * Builds the upsert-and-replace statements for a /results batch. Returns the
 * statement array (to be passed to `db.batch`) plus the clientKey→id map the
 * reporter uses to fire per-test artifact uploads.
 *
 * Existing rows (matched on `runId, testId`) are UPDATEd in place; child
 * rows (tags, annotations, attempts) for those ids are DELETEd first so the
 * new set replaces them cleanly. Fresh rows are INSERTed in chunks.
 */
export function buildResultInsertStatements(
  scope: TenantScope,
  runId: string,
  results: TestResultInput[],
  nowSeconds: number,
  existingIds: Map<string, string>,
  assignedIds: Map<string, string>,
) {
  const insertRows: Array<{
    id: string;
    projectId: string;
    runId: string;
    testId: string;
    title: string;
    file: string;
    projectName: string | null;
    status: string;
    durationMs: number;
    retryCount: number;
    errorMessage: string | null;
    errorStack: string | null;
    workerIndex: number | null;
    createdAt: number;
  }> = [];
  const tagRows: Array<{
    id: string;
    projectId: string;
    testResultId: string;
    tag: string;
  }> = [];
  const annotationRows: Array<{
    id: string;
    projectId: string;
    testResultId: string;
    type: string;
    description: string | null;
  }> = [];
  const attemptRows: Array<{
    id: string;
    projectId: string;
    testResultId: string;
    attempt: number;
    status: string;
    durationMs: number;
    errorMessage: string | null;
    errorStack: string | null;
    createdAt: number;
  }> = [];
  const mapping: ResultMapping[] = [];
  // `PromiseLike<unknown>[]` because Drizzle batch accepts a heterogeneous
  // tuple of insert/update/delete builders; expressing the union precisely
  // fights the type system more than it helps callers. Every pushed value is
  // a thenable Drizzle query — same runtime shape.
  const statements: PromiseLike<unknown>[] = [];

  for (const result of results) {
    const testResultId = assignedIds.get(result.testId);
    if (!testResultId) continue;
    if (result.clientKey) {
      mapping.push({ clientKey: result.clientKey, testResultId });
    }

    if (existingIds.has(result.testId)) {
      statements.push(
        db
          .update(testResults)
          .set({
            title: result.title,
            file: result.file,
            projectName: result.projectName ?? null,
            status: result.status,
            durationMs: result.durationMs,
            retryCount: result.retryCount,
            errorMessage: result.errorMessage ?? null,
            errorStack: result.errorStack ?? null,
            workerIndex: result.workerIndex ?? null,
            createdAt: nowSeconds,
          })
          .where(
            and(
              eq(testResults.projectId, scope.projectId),
              eq(testResults.id, testResultId),
            ),
          ) as never,
      );
      statements.push(
        db
          .delete(testTags)
          .where(
            and(
              eq(testTags.projectId, scope.projectId),
              eq(testTags.testResultId, testResultId),
            ),
          ) as never,
      );
      statements.push(
        db
          .delete(testAnnotations)
          .where(
            and(
              eq(testAnnotations.projectId, scope.projectId),
              eq(testAnnotations.testResultId, testResultId),
            ),
          ) as never,
      );
    } else {
      insertRows.push({
        id: testResultId,
        projectId: scope.projectId,
        runId,
        testId: result.testId,
        title: result.title,
        file: result.file,
        projectName: result.projectName ?? null,
        status: result.status,
        durationMs: result.durationMs,
        retryCount: result.retryCount,
        errorMessage: result.errorMessage ?? null,
        errorStack: result.errorStack ?? null,
        workerIndex: result.workerIndex ?? null,
        createdAt: nowSeconds,
      });
    }

    // Per-attempt rows are fully owned by this result. Re-send re-creates
    // the set so the reporter staying idempotent under flush retry.
    statements.push(
      db
        .delete(testResultAttempts)
        .where(
          and(
            eq(testResultAttempts.projectId, scope.projectId),
            eq(testResultAttempts.testResultId, testResultId),
          ),
        ) as never,
    );
    for (const attempt of result.attempts) {
      attemptRows.push({
        id: ulid(),
        projectId: scope.projectId,
        testResultId,
        attempt: attempt.attempt,
        status: attempt.status,
        durationMs: attempt.durationMs,
        errorMessage: attempt.errorMessage ?? null,
        errorStack: attempt.errorStack ?? null,
        createdAt: nowSeconds,
      });
    }
    for (const tag of result.tags) {
      tagRows.push({
        id: ulid(),
        projectId: scope.projectId,
        testResultId,
        tag,
      });
    }
    for (const annotation of result.annotations) {
      annotationRows.push({
        id: ulid(),
        projectId: scope.projectId,
        testResultId,
        type: annotation.type,
        description: annotation.description ?? null,
      });
    }
  }

  for (const chunk of chunkByParams(insertRows, TEST_RESULTS_COLUMNS)) {
    statements.push(db.insert(testResults).values(chunk));
  }
  for (const chunk of chunkByParams(tagRows, TEST_TAGS_COLUMNS)) {
    statements.push(db.insert(testTags).values(chunk));
  }
  for (const chunk of chunkByParams(annotationRows, TEST_ANNOTATIONS_COLUMNS)) {
    statements.push(db.insert(testAnnotations).values(chunk));
  }
  for (const chunk of chunkByParams(
    attemptRows,
    TEST_RESULT_ATTEMPTS_COLUMNS,
  )) {
    statements.push(db.insert(testResultAttempts).values(chunk));
  }
  return { statements, mapping };
}

export interface AggregateDelta {
  totalTests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

export function statusBucket(status: string): keyof AggregateDelta | null {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
    case "timedout":
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    default:
      return null;
  }
}

/**
 * Compute aggregate-column deltas given each row's previous status. Same
 * algorithm as the DO version — avoids a 5-subquery scan of the testResults
 * table on every /results batch.
 */
export function computeAggregateDelta(
  results: ReadonlyArray<{ testId: string; status: string }>,
  prevStatusByTestId: ReadonlyMap<string, string>,
): AggregateDelta {
  const delta: AggregateDelta = {
    totalTests: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
  };
  for (const r of results) {
    const prev = prevStatusByTestId.get(r.testId);
    const nextBucket = statusBucket(r.status);
    if (prev === undefined) {
      delta.totalTests += 1;
      if (nextBucket) delta[nextBucket] += 1;
      continue;
    }
    const prevBucket = statusBucket(prev);
    if (prevBucket === nextBucket) continue;
    if (prevBucket) delta[prevBucket] -= 1;
    if (nextBucket) delta[nextBucket] += 1;
  }
  return delta;
}

export function aggregateDeltaStatement(
  scope: TenantScope,
  runId: string,
  delta: AggregateDelta,
) {
  if (
    delta.totalTests === 0 &&
    delta.passed === 0 &&
    delta.failed === 0 &&
    delta.flaky === 0 &&
    delta.skipped === 0
  ) {
    return null;
  }
  return db
    .update(runs)
    .set({
      totalTests: sql`${runs.totalTests} + ${delta.totalTests}`,
      passed: sql`${runs.passed} + ${delta.passed}`,
      failed: sql`${runs.failed} + ${delta.failed}`,
      flaky: sql`${runs.flaky} + ${delta.flaky}`,
      skipped: sql`${runs.skipped} + ${delta.skipped}`,
    })
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, runId)))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

export function aggregateRecomputeStatement(scope: TenantScope, runId: string) {
  const projectId = scope.projectId;
  return db
    .update(runs)
    .set({
      totalTests: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId})`,
      passed: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND "status" = 'passed')`,
      failed: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND "status" IN ('failed', 'timedout'))`,
      flaky: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND "status" = 'flaky')`,
      skipped: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND "status" = 'skipped')`,
    })
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

/**
 * SELECT the publishable summary inside a batch. Used in the no-delta path of
 * `/results` where the aggregate UPDATE is skipped but we still need a
 * transactionally-consistent snapshot to broadcast alongside the per-test
 * changes.
 */
export function aggregateSummarySelectStatement(
  scope: TenantScope,
  runId: string,
) {
  return db
    .select(AGGREGATE_SUMMARY_COLUMNS)
    .from(runs)
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, runId)));
}

/**
 * Bump `teams.lastActivityAt`. Awaited per the no-fire-and-forget rule —
 * workerd terminates orphaned promises after the response so an unawaited
 * write can be silently dropped.
 */
export async function bumpTeamActivity(
  teamId: string,
  nowSeconds: number,
): Promise<void> {
  await db
    .update(teams)
    .set({ lastActivityAt: nowSeconds })
    .where(eq(teams.id, teamId));
}

export function buildChangedTests(
  results: readonly TestResultInput[],
  assignedIds: Map<string, string>,
): RunProgressTest[] {
  return results.map((r) => ({
    id: assignedIds.get(r.testId)!,
    testId: r.testId,
    title: r.title,
    file: r.file,
    projectName: r.projectName ?? null,
    status: r.status,
    durationMs: r.durationMs,
    retryCount: r.retryCount,
    errorMessage: r.errorMessage ?? null,
    errorStack: r.errorStack ?? null,
  }));
}

/**
 * Publish a progress event to `run:<runId>` subscribers. Pure pub — the caller
 * is responsible for producing a `summary` that is transactionally consistent
 * with `changedTests` (typically via `.returning()` on the aggregate UPDATE in
 * the same batch, or `aggregateSummarySelectStatement` when no UPDATE runs).
 * Awaited because the publish RPC mustn't be dropped by workerd termination.
 */
export async function broadcastRunUpdate(
  runId: string,
  changedTests: RunProgressTest[],
  summary: RunAggregateSummary,
): Promise<void> {
  await publishRunUpdate(runId, {
    type: "progress",
    changedTests,
    summary,
  });
}
