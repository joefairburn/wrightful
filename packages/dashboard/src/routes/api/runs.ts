import { type Compilable, sql } from "kysely";
import { ulid } from "ulid";
import { getDb } from "@/db";
import { type TenantScope, tenantScopeForApiKey } from "@/tenant";
import {
  OpenRunPayloadSchema,
  AppendResultsPayloadSchema,
  CompleteRunPayloadSchema,
  type AppendResultsPayload,
  type CompleteRunPayload,
  type OpenRunPayload,
  type TestResultInput,
} from "./schemas";
import { broadcastRunProgress } from "./progress";
import type { AppContext } from "@/worker";

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Even though tenant DOs don't enforce D1's 100-param cap, we still chunk
// multi-row INSERTs. It keeps statements readable, bounds memory for very
// large appends, and matches the reporter's existing batching cadence.
const MAX_PARAMS_PER_STATEMENT = 99;
const TEST_RESULTS_COLUMNS = 13;
const TEST_TAGS_COLUMNS = 3;
const TEST_ANNOTATIONS_COLUMNS = 4;
const TEST_RESULT_ATTEMPTS_COLUMNS = 7;

function chunkByParams<T>(rows: T[], columnsPerRow: number): T[][] {
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

interface ResultMapping {
  clientKey: string;
  testResultId: string;
}

function runUrl(scope: TenantScope, id: string) {
  return `/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${id}`;
}

async function resolveTestResultIds(
  scope: TenantScope,
  runId: string,
  testIds: string[],
): Promise<{
  existingIds: Map<string, string>;
  assignedIds: Map<string, string>;
}> {
  const existingIds = new Map<string, string>();
  if (testIds.length > 0) {
    const rows = await scope.db
      .selectFrom("testResults")
      .select(["id", "testId"])
      .where("runId", "=", runId)
      .where("testId", "in", testIds)
      .execute();
    for (const row of rows) {
      existingIds.set(row.testId, row.id);
    }
  }
  const assignedIds = new Map<string, string>();
  for (const testId of testIds) {
    assignedIds.set(testId, existingIds.get(testId) ?? ulid());
  }
  return { existingIds, assignedIds };
}

/**
 * Build batch statements that upsert testResults + replace their tags and
 * annotations. The whole set is sent to the tenant DO as one atomic
 * transaction via `scope.batch`.
 *
 * - If a row already exists for `(runId, testId)` (typical case: the run
 *   was opened with a queue prefill), UPDATE in place. Tags and
 *   annotations belonging to that existing id are DELETEd first so the
 *   new set replaces them cleanly.
 * - Otherwise INSERT a fresh row.
 */
function buildResultInsertStatements(
  scope: TenantScope,
  runId: string,
  results: TestResultInput[],
  nowSeconds: number,
  existingIds: Map<string, string>,
  assignedIds: Map<string, string>,
): { statements: Compilable[]; mapping: ResultMapping[] } {
  const insertRows: Array<{
    id: string;
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
  const tagRows: Array<{ id: string; testResultId: string; tag: string }> = [];
  const annotationRows: Array<{
    id: string;
    testResultId: string;
    type: string;
    description: string | null;
  }> = [];
  const attemptRows: Array<{
    id: string;
    testResultId: string;
    attempt: number;
    status: string;
    durationMs: number;
    errorMessage: string | null;
    errorStack: string | null;
    createdAt: number;
  }> = [];
  const mapping: ResultMapping[] = [];
  const statements: Compilable[] = [];

  for (const result of results) {
    const testResultId = assignedIds.get(result.testId);
    if (!testResultId) continue;
    if (result.clientKey) {
      mapping.push({ clientKey: result.clientKey, testResultId });
    }

    if (existingIds.has(result.testId)) {
      statements.push(
        scope.db
          .updateTable("testResults")
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
          .where("id", "=", testResultId),
      );
      statements.push(
        scope.db
          .deleteFrom("testTags")
          .where("testResultId", "=", testResultId),
      );
      statements.push(
        scope.db
          .deleteFrom("testAnnotations")
          .where("testResultId", "=", testResultId),
      );
    } else {
      insertRows.push({
        id: testResultId,
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

    // Per-attempt rows are fully owned by this result. Delete any existing
    // set first so the reporter re-sending (flush retry, or running with
    // fewer retries than before) stays idempotent.
    statements.push(
      scope.db
        .deleteFrom("testResultAttempts")
        .where("testResultId", "=", testResultId),
    );
    for (const attempt of result.attempts) {
      attemptRows.push({
        id: ulid(),
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
      tagRows.push({ id: ulid(), testResultId, tag });
    }
    for (const annotation of result.annotations) {
      annotationRows.push({
        id: ulid(),
        testResultId,
        type: annotation.type,
        description: annotation.description ?? null,
      });
    }
  }

  for (const chunk of chunkByParams(insertRows, TEST_RESULTS_COLUMNS)) {
    statements.push(scope.db.insertInto("testResults").values(chunk));
  }
  for (const chunk of chunkByParams(tagRows, TEST_TAGS_COLUMNS)) {
    statements.push(scope.db.insertInto("testTags").values(chunk));
  }
  for (const chunk of chunkByParams(annotationRows, TEST_ANNOTATIONS_COLUMNS)) {
    statements.push(scope.db.insertInto("testAnnotations").values(chunk));
  }
  for (const chunk of chunkByParams(
    attemptRows,
    TEST_RESULT_ATTEMPTS_COLUMNS,
  )) {
    statements.push(scope.db.insertInto("testResultAttempts").values(chunk));
  }
  return { statements, mapping };
}

/**
 * Prefill one queued testResults row per planned test at openRun. The
 * unique `(runId, testId)` index lets /results later upsert these
 * in place.
 */
function buildQueuePrefillStatements(
  scope: TenantScope,
  runId: string,
  plannedTests: ReadonlyArray<{
    testId: string;
    title: string;
    file: string;
    projectName?: string | null | undefined;
  }>,
  nowSeconds: number,
): Compilable[] {
  if (plannedTests.length === 0) return [];
  const rows = plannedTests.map((p) => ({
    id: ulid(),
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
  const statements: Compilable[] = [];
  for (const chunk of chunkByParams(rows, TEST_RESULTS_COLUMNS)) {
    statements.push(scope.db.insertInto("testResults").values(chunk));
  }
  return statements;
}

/**
 * Build a single UPDATE that recomputes run aggregates from testResults.
 * Derives counts in one statement — avoids a round-trip to SELECT first.
 * Identifiers are camelCase (the tenant DO doesn't run CamelCasePlugin).
 */
function aggregateRecomputeStatement(
  scope: TenantScope,
  runId: string,
): Compilable {
  return scope.db
    .updateTable("runs")
    .set({
      totalTests: sql<number>`(SELECT COUNT(*) FROM "testResults" WHERE "runId" = ${runId})`,
      passed: sql<number>`(SELECT COUNT(*) FROM "testResults" WHERE "runId" = ${runId} AND "status" = 'passed')`,
      failed: sql<number>`(SELECT COUNT(*) FROM "testResults" WHERE "runId" = ${runId} AND "status" IN ('failed', 'timedout'))`,
      flaky: sql<number>`(SELECT COUNT(*) FROM "testResults" WHERE "runId" = ${runId} AND "status" = 'flaky')`,
      skipped: sql<number>`(SELECT COUNT(*) FROM "testResults" WHERE "runId" = ${runId} AND "status" = 'skipped')`,
    })
    .where("id", "=", runId);
}

/**
 * Fire-and-forget bump of `teams.lastActivityAt` on the control DB. The
 * watchdog in `scheduled.ts` uses this to skip idle teams during its
 * sweep; a missed update doesn't break correctness (the sweep still
 * picks it up on the next cron tick if anything got stuck).
 */
function bumpTeamActivity(teamId: string, nowSeconds: number): void {
  getDb()
    .updateTable("teams")
    .set({ lastActivityAt: nowSeconds })
    .where("id", "=", teamId)
    .execute()
    .catch(() => {});
}

/**
 * POST /api/runs — open a streaming run.
 *
 * Visible (committed=true) from the moment it's opened so the dashboard can
 * render results as they stream in. Aggregates start at zero and are
 * recomputed on each /results append.
 *
 * Idempotent on (projectId, idempotencyKey): resending the same key returns
 * the existing runId rather than creating a duplicate run. Lets multiple
 * Playwright shards — each of which runs its own reporter — converge on
 * one run for a CI build.
 */
export async function openRunHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  if (!ctx.apiKey) return jsonResponse({ error: "Unauthorized" }, 401);

  let payload: OpenRunPayload;
  try {
    payload = OpenRunPayloadSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const scope = await tenantScopeForApiKey(ctx.apiKey);
  if (!scope) return jsonResponse({ error: "Unauthorized" }, 401);

  const existing = await scope.db
    .selectFrom("runs")
    .select("id")
    .where("projectId", "=", scope.projectId)
    .where("idempotencyKey", "=", payload.idempotencyKey)
    .limit(1)
    .execute();
  if (existing.length > 0) {
    return jsonResponse(
      {
        runId: existing[0].id,
        runUrl: runUrl(scope, existing[0].id),
        duplicate: true,
      },
      200,
    );
  }

  const runId = ulid();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const plannedTests = payload.run.plannedTests ?? [];

  const runRow = {
    id: runId,
    projectId: scope.projectId,
    idempotencyKey: payload.idempotencyKey,
    ciProvider: payload.run.ciProvider ?? null,
    ciBuildId: payload.run.ciBuildId ?? null,
    branch: payload.run.branch ?? null,
    environment: payload.run.environment ?? null,
    commitSha: payload.run.commitSha ?? null,
    commitMessage: payload.run.commitMessage ?? null,
    prNumber: payload.run.prNumber ?? null,
    repo: payload.run.repo ?? null,
    actor: payload.run.actor ?? null,
    totalTests: plannedTests.length,
    expectedTotalTests: payload.run.expectedTotalTests ?? plannedTests.length,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    reporterVersion: payload.run.reporterVersion ?? null,
    playwrightVersion: payload.run.playwrightVersion ?? null,
    createdAt: nowSeconds,
    completedAt: null,
    committed: 1,
  };

  const openStatements: Compilable[] = [
    scope.db.insertInto("runs").values(runRow),
    ...buildQueuePrefillStatements(scope, runId, plannedTests, nowSeconds),
  ];
  await scope.batch(openStatements);
  bumpTeamActivity(scope.teamId, nowSeconds);
  await broadcastRunProgress(scope, runId);

  return jsonResponse({ runId, runUrl: runUrl(scope, runId) }, 201);
}

/**
 * POST /api/runs/:id/results — append a batch of test results.
 *
 * Validates that the run belongs to this API key's project, then inserts
 * rows + recomputes aggregates in a single tenant-DO transaction. Returns
 * the clientKey → testResultId mapping so the reporter can fire per-test
 * artifact uploads in parallel as tests complete.
 */
export async function appendResultsHandler({
  request,
  params,
  ctx,
}: {
  request: Request;
  params: Record<string, string>;
  ctx: AppContext;
}) {
  if (!ctx.apiKey) return jsonResponse({ error: "Unauthorized" }, 401);

  const runId = params.id;
  if (!runId) return jsonResponse({ error: "Not found" }, 404);

  let payload: AppendResultsPayload;
  try {
    payload = AppendResultsPayloadSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const scope = await tenantScopeForApiKey(ctx.apiKey);
  if (!scope) return jsonResponse({ error: "Unauthorized" }, 401);

  const owner = await scope.db
    .selectFrom("runs")
    .select("id")
    .where("id", "=", runId)
    .where("projectId", "=", scope.projectId)
    .limit(1)
    .executeTakeFirst();
  if (!owner) return jsonResponse({ error: "Run not found" }, 404);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const testIds = payload.results.map((r) => r.testId);
  const { existingIds, assignedIds } = await resolveTestResultIds(
    scope,
    runId,
    testIds,
  );
  const { statements, mapping } = buildResultInsertStatements(
    scope,
    runId,
    payload.results,
    nowSeconds,
    existingIds,
    assignedIds,
  );
  statements.push(aggregateRecomputeStatement(scope, runId));
  await scope.batch(statements);
  bumpTeamActivity(scope.teamId, nowSeconds);

  await broadcastRunProgress(scope, runId);

  return jsonResponse({ results: mapping }, 200);
}

/**
 * POST /api/runs/:id/complete — finalize a streaming run.
 *
 * Sets the terminal status + completedAt + final durationMs and does one
 * last aggregate recompute in case a straggler /results call raced with
 * this. Idempotent: a second call from another shard just re-sets the
 * same values.
 */
export async function completeRunHandler({
  request,
  params,
  ctx,
}: {
  request: Request;
  params: Record<string, string>;
  ctx: AppContext;
}) {
  if (!ctx.apiKey) return jsonResponse({ error: "Unauthorized" }, 401);

  const runId = params.id;
  if (!runId) return jsonResponse({ error: "Not found" }, 404);

  let payload: CompleteRunPayload;
  try {
    payload = CompleteRunPayloadSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const scope = await tenantScopeForApiKey(ctx.apiKey);
  if (!scope) return jsonResponse({ error: "Unauthorized" }, 401);

  const owner = await scope.db
    .selectFrom("runs")
    .select("id")
    .where("id", "=", runId)
    .where("projectId", "=", scope.projectId)
    .limit(1)
    .executeTakeFirst();
  if (!owner) return jsonResponse({ error: "Run not found" }, 404);

  const nowSeconds = Math.floor(Date.now() / 1000);
  await scope.batch([
    scope.db
      .updateTable("runs")
      .set({
        status: payload.status,
        durationMs: payload.durationMs,
        completedAt: nowSeconds,
      })
      .where("id", "=", runId),
    aggregateRecomputeStatement(scope, runId),
  ]);
  bumpTeamActivity(scope.teamId, nowSeconds);

  await broadcastRunProgress(scope, runId);

  return jsonResponse({ runId, status: payload.status }, 200);
}
