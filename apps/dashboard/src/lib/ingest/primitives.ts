import { ulid } from "ulid";
import { and, db, eq, inArray, sql } from "void/db";
import { logger } from "void/log";
import {
  runs,
  testAnnotations,
  testResultAttempts,
  testResults,
  tests,
  testTags,
  teams,
} from "@schema";
import type { BatchExecutor } from "@/lib/db/batch";
import { changedRows, runBatch } from "@/lib/db/batch";
import { setCodeownersFile } from "@/lib/owners-repo";
import {
  childByTestResultsWhere,
  childProjectScopeWhere,
  runByIdWhere,
  type TenantScope,
} from "@/lib/scope";
import { STATUS_BUCKETS, WIRE_INVISIBLE_STATUSES } from "@/lib/status-buckets";
import { broadcastProjectRoom, broadcastRunRoom } from "@/realtime/publish";
import type { TestResultInput } from "@/lib/schemas";
import type {
  ProjectFeedEvent,
  RunProgressEvent,
  RunProgressTest,
} from "@/realtime/events";

/** Columns published in every `RunProgressEvent.summary`. */
export const AGGREGATE_SUMMARY_COLUMNS = {
  totalTests: runs.totalTests,
  expectedTotalTests: runs.expectedTotalTests,
  passed: runs.passed,
  failed: runs.failed,
  flaky: runs.flaky,
  skipped: runs.skipped,
  durationMs: runs.durationMs,
  status: runs.status,
  completedAt: runs.completedAt,
} as const;

export type RunAggregateSummary = RunProgressEvent["summary"];

/** Postgres's per-statement bound-parameter ceiling. */
export const PG_MAX_BOUND_PARAMS = 65_535;

export function chunkBySize<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    chunks.push(items.slice(i, i + step));
  }
  return chunks;
}

export function chunkByParams<T>(
  rows: T[],
  columnsPerRow: number,
  maxParams: number = PG_MAX_BOUND_PARAMS,
): T[][] {
  return chunkBySize(rows, Math.floor(maxParams / columnsPerRow));
}

export function chunkInsertRows<T extends Record<string, unknown>>(
  rows: T[],
): T[][] {
  if (rows.length === 0) return [];
  return chunkByParams(rows, Object.keys(rows[0]).length);
}

export interface ResultMapping {
  clientKey: string;
  testResultId: string;
}

export async function resolveTestResultIds(
  scope: TenantScope,
  runId: string,
  testIds: string[],
  exec: Pick<typeof db, "select"> = db,
): Promise<{
  existingIds: Map<string, string>;
  assignedIds: Map<string, string>;
  prevStatusByTestId: Map<string, string>;
}> {
  const existingIds = new Map<string, string>();
  const prevStatusByTestId = new Map<string, string>();
  const rows = await exec
    .select({
      id: testResults.id,
      testId: testResults.testId,
      status: testResults.status,
    })
    .from(testResults)
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        eq(testResults.runId, runId),
        inArray(testResults.testId, testIds),
      ),
    );
  for (const row of rows) {
    existingIds.set(row.testId, row.id);
    prevStatusByTestId.set(row.testId, row.status);
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
  exec: BatchExecutor,
  shardIndex: number | null = null,
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
    shardIndex,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
  }));
  return chunkInsertRows(rows).map((chunk) =>
    exec.insert(testResults).values(chunk).onConflictDoNothing(),
  );
}

export function buildTestCatalogUpsertStatements(
  scope: TenantScope,
  entries: ReadonlyArray<{ testId: string; title: string; file: string }>,
  nowSeconds: number,
  exec: BatchExecutor,
) {
  if (entries.length === 0) return [];
  const byTestId = new Map<string, { title: string; file: string }>();
  for (const entry of entries) {
    byTestId.set(entry.testId, { title: entry.title, file: entry.file });
  }
  const rows = [...byTestId]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([testId, { title, file }]) => ({
      id: ulid(),
      projectId: scope.projectId,
      testId,
      title,
      file,
      firstSeenAt: nowSeconds,
      lastSeenAt: nowSeconds,
    }));
  return chunkInsertRows(rows).map((chunk) =>
    exec
      .insert(tests)
      .values(chunk)
      .onConflictDoUpdate({
        target: [tests.projectId, tests.testId],
        set: {
          title: sql`excluded."title"`,
          file: sql`excluded."file"`,
          lastSeenAt: sql`excluded."lastSeenAt"`,
        },
      }),
  );
}

function resultUpsertSet() {
  return {
    title: sql`excluded."title"`,
    file: sql`excluded."file"`,
    projectName: sql`excluded."projectName"`,
    status: sql`excluded."status"`,
    durationMs: sql`excluded."durationMs"`,
    retryCount: sql`excluded."retryCount"`,
    errorMessage: sql`excluded."errorMessage"`,
    errorStack: sql`excluded."errorStack"`,
    workerIndex: sql`excluded."workerIndex"`,
    shardIndex: sql`excluded."shardIndex"`,
    updatedAt: sql`excluded."updatedAt"`,
  };
}

export function buildResultInsertStatements(
  scope: TenantScope,
  runId: string,
  results: TestResultInput[],
  nowSeconds: number,
  _existingIds: Map<string, string>,
  assignedIds: Map<string, string>,
  exec: BatchExecutor,
) {
  const insertRows: (typeof testResults.$inferInsert)[] = [];
  const tagRows: (typeof testTags.$inferInsert)[] = [];
  const annotationRows: (typeof testAnnotations.$inferInsert)[] = [];
  const attemptRows: (typeof testResultAttempts.$inferInsert)[] = [];
  const childReplaceIds: string[] = [];
  const mapping: ResultMapping[] = [];
  const statements: PromiseLike<unknown>[] = [];

  for (const result of results) {
    const testResultId = assignedIds.get(result.testId);
    if (!testResultId) continue;
    if (result.clientKey) {
      mapping.push({ clientKey: result.clientKey, testResultId });
    }
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
      shardIndex: result.shardIndex ?? null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    });
    childReplaceIds.push(testResultId);
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
        stdout: attempt.stdout ?? null,
        stderr: attempt.stderr ?? null,
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

  for (const chunk of chunkInsertRows(insertRows)) {
    statements.push(
      exec
        .insert(testResults)
        .values(chunk)
        .onConflictDoUpdate({
          target: [testResults.runId, testResults.testId],
          set: resultUpsertSet(),
        }),
    );
  }
  for (const chunk of chunkBySize(childReplaceIds, PG_MAX_BOUND_PARAMS - 1)) {
    statements.push(
      exec
        .delete(testTags)
        .where(childByTestResultsWhere(testTags, scope, chunk)),
    );
    statements.push(
      exec
        .delete(testAnnotations)
        .where(childByTestResultsWhere(testAnnotations, scope, chunk)),
    );
    statements.push(
      exec
        .delete(testResultAttempts)
        .where(childByTestResultsWhere(testResultAttempts, scope, chunk)),
    );
  }
  for (const chunk of chunkInsertRows(tagRows)) {
    statements.push(exec.insert(testTags).values(chunk));
  }
  for (const chunk of chunkInsertRows(annotationRows)) {
    statements.push(exec.insert(testAnnotations).values(chunk));
  }
  for (const chunk of chunkInsertRows(attemptRows)) {
    statements.push(exec.insert(testResultAttempts).values(chunk));
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

export const STATUS_BUCKET_MEMBERS = {
  passed: STATUS_BUCKETS.passed.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  failed: STATUS_BUCKETS.failed.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  flaky: STATUS_BUCKETS.flaky.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  skipped: STATUS_BUCKETS.skipped.filter(
    (s) => !WIRE_INVISIBLE_STATUSES.has(s),
  ),
} satisfies Record<
  Exclude<keyof AggregateDelta, "totalTests">,
  readonly string[]
>;

const STATUS_TO_BUCKET: ReadonlyMap<string, keyof AggregateDelta> = new Map(
  Object.entries(STATUS_BUCKET_MEMBERS).flatMap(([bucket, statuses]) =>
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Object.entries erases literal key types
    statuses.map((status) => [status, bucket as keyof AggregateDelta] as const),
  ),
);

export function statusBucket(status: string): keyof AggregateDelta | null {
  return STATUS_TO_BUCKET.get(status) ?? null;
}

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
  for (const result of results) {
    const previous = prevStatusByTestId.get(result.testId);
    const nextBucket = statusBucket(result.status);
    if (previous === undefined) {
      delta.totalTests += 1;
      if (nextBucket) delta[nextBucket] += 1;
      continue;
    }
    const previousBucket = statusBucket(previous);
    if (previousBucket === nextBucket) continue;
    if (previousBucket) delta[previousBucket] -= 1;
    if (nextBucket) delta[nextBucket] += 1;
  }
  return delta;
}

export function aggregateDeltaStatement(
  scope: TenantScope,
  runId: string,
  delta: AggregateDelta,
  nowSeconds: number,
  exec: BatchExecutor,
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
  return exec
    .update(runs)
    .set({
      totalTests: sql`${runs.totalTests} + ${delta.totalTests}`,
      passed: sql`${runs.passed} + ${delta.passed}`,
      failed: sql`${runs.failed} + ${delta.failed}`,
      flaky: sql`${runs.flaky} + ${delta.flaky}`,
      skipped: sql`${runs.skipped} + ${delta.skipped}`,
      lastActivityAt: nowSeconds,
    })
    .where(runByIdWhere(scope, runId))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

export function activityBumpStatement(
  scope: TenantScope,
  runId: string,
  nowSeconds: number,
  exec: BatchExecutor,
) {
  return exec
    .update(runs)
    .set({ lastActivityAt: nowSeconds })
    .where(runByIdWhere(scope, runId))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

export function statusMatchSql(statuses: readonly string[]) {
  const list = statuses.map((status) => `'${status}'`).join(", ");
  return statuses.length === 1
    ? sql.raw(`"status" = ${list}`)
    : sql.raw(`"status" IN (${list})`);
}

export function aggregateRecomputeStatement(
  scope: { projectId: string },
  runId: string,
  exec: BatchExecutor,
) {
  const projectId = scope.projectId;
  const bucketCount = (statuses: readonly string[]) =>
    sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId} AND ${statusMatchSql(statuses)})`;
  return exec
    .update(runs)
    .set({
      totalTests: sql`(SELECT COUNT(*) FROM "testResults" WHERE "projectId" = ${projectId} AND "runId" = ${runId})`,
      passed: bucketCount(STATUS_BUCKET_MEMBERS.passed),
      failed: bucketCount(STATUS_BUCKET_MEMBERS.failed),
      flaky: bucketCount(STATUS_BUCKET_MEMBERS.flaky),
      skipped: bucketCount(STATUS_BUCKET_MEMBERS.skipped),
    })
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .returning(AGGREGATE_SUMMARY_COLUMNS);
}

export function summaryFromBatchResults(
  batchResults: readonly unknown[],
): RunAggregateSummary | null {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the tail statement owns this returning shape
  const rows = batchResults[batchResults.length - 1] as
    | readonly RunAggregateSummary[]
    | undefined;
  return rows?.[0] ?? null;
}

export const statementChangedRows = changedRows;

export async function reconcileAndBroadcast(
  runId: string,
  buildStatusUpdate: (exec: BatchExecutor) => PromiseLike<unknown>,
  recomputeScope: { projectId: string },
  opts?: { requireStatusFlip?: boolean },
): Promise<RunAggregateSummary | null> {
  const batchResults = await runBatch((tx) => [
    buildStatusUpdate(tx),
    aggregateRecomputeStatement(recomputeScope, runId, tx),
  ]);
  const summary = summaryFromBatchResults(batchResults);
  if (opts?.requireStatusFlip && statementChangedRows(batchResults[0]) === 0) {
    return summary;
  }
  if (summary) {
    await broadcastRunProgress(runId, recomputeScope.projectId, summary);
  }
  return summary;
}

export async function maybeUpdateCodeowners(
  scope: TenantScope,
  codeowners: string | undefined,
  nowSeconds: number,
): Promise<void> {
  if (typeof codeowners !== "string" || codeowners.trim().length === 0) return;
  try {
    await setCodeownersFile(scope, codeowners, nowSeconds);
  } catch (err) {
    logger.error("update codeowners from ingest failed", {
      projectId: scope.projectId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

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
  return results.map((result) => ({
    id: assignedIds.get(result.testId)!,
    testId: result.testId,
    title: result.title,
    file: result.file,
    projectName: result.projectName ?? null,
    status: result.status,
    durationMs: result.durationMs,
    retryCount: result.retryCount,
    shardIndex: result.shardIndex ?? null,
  }));
}

export async function broadcastRunUpdate(
  runId: string,
  changedTests: RunProgressTest[],
  summary: RunAggregateSummary,
): Promise<void> {
  const event: RunProgressEvent = { type: "progress", changedTests, summary };
  await broadcastRunRoom(runId, event);
}

export async function broadcastRunProgress(
  runId: string,
  projectId: string,
  summary: RunAggregateSummary,
): Promise<void> {
  await broadcastRunUpdate(runId, [], summary);
  const event: ProjectFeedEvent = { type: "run-progress", runId, summary };
  await broadcastProjectRoom(projectId, event);
}
