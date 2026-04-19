import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ulid } from "ulid";
import { getDb, type Db } from "@/db";
import {
  projects,
  runs,
  teams,
  testAnnotations,
  testResults,
  testTags,
} from "@/db/schema";
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

// D1 caps: 100 bound parameters per query, 1000 statements per batch. We
// chunk multi-row inserts so no statement exceeds the param cap, then split
// those statements across 1000-statement batches.
const MAX_PARAMS_PER_STATEMENT = 99;
const MAX_STATEMENTS_PER_BATCH = 1000;
const TEST_RESULTS_COLUMNS = 13;
const TEST_TAGS_COLUMNS = 3;
const TEST_ANNOTATIONS_COLUMNS = 4;

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

/**
 * Resolve the `(runId, testId)` pair to the test_result row's `id`, preferring
 * a prefilled queued row if one exists. The caller gets a map from the input
 * `testId` to the id to use (existing or fresh). Existing-row ids let us
 * UPDATE in place; fresh ids are for the safety net where a reporter skipped
 * the queue prefill.
 */
async function resolveTestResultIds(
  db: Db,
  runId: string,
  testIds: string[],
): Promise<{
  existingIds: Map<string, string>;
  assignedIds: Map<string, string>;
}> {
  const existingIds = new Map<string, string>();
  if (testIds.length > 0) {
    const rows = await db
      .select({ id: testResults.id, testId: testResults.testId })
      .from(testResults)
      .where(
        and(eq(testResults.runId, runId), inArray(testResults.testId, testIds)),
      );
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
 * Build batch statements that upsert test_results + replace their tags and
 * annotations, chunked to respect D1's per-statement parameter cap.
 *
 * - If a row already exists for `(run_id, test_id)` (typical case: the run
 *   was opened with a queue prefill), we UPDATE it in place. Tags and
 *   annotations belonging to that existing id are DELETEd first so the new
 *   set replaces them cleanly.
 * - If no row exists (a reporter that skipped the prefill, or a test added
 *   dynamically), we INSERT a fresh row.
 */
function buildResultInsertStatements(
  db: Db,
  runId: string,
  results: TestResultInput[],
  now: Date,
  existingIds: Map<string, string>,
  assignedIds: Map<string, string>,
): { statements: BatchItem<"sqlite">[]; mapping: ResultMapping[] } {
  const insertRows: (typeof testResults.$inferInsert)[] = [];
  const tagRows: (typeof testTags.$inferInsert)[] = [];
  const annotationRows: (typeof testAnnotations.$inferInsert)[] = [];
  const mapping: ResultMapping[] = [];
  const statements: BatchItem<"sqlite">[] = [];

  for (const result of results) {
    const testResultId = assignedIds.get(result.testId);
    if (!testResultId) continue;
    if (result.clientKey) {
      mapping.push({ clientKey: result.clientKey, testResultId });
    }

    if (existingIds.has(result.testId)) {
      // UPDATE in place — preserves the row id so artifacts referencing it
      // stay valid.
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
            createdAt: now,
          })
          .where(eq(testResults.id, testResultId)),
      );
      // Replace tags / annotations for this row. Tag lists are short (a few
      // per test at most), so DELETE-then-INSERT is cheaper than diffing.
      statements.push(
        db.delete(testTags).where(eq(testTags.testResultId, testResultId)),
      );
      statements.push(
        db
          .delete(testAnnotations)
          .where(eq(testAnnotations.testResultId, testResultId)),
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
        createdAt: now,
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
    statements.push(db.insert(testResults).values(chunk));
  }
  for (const chunk of chunkByParams(tagRows, TEST_TAGS_COLUMNS)) {
    statements.push(db.insert(testTags).values(chunk));
  }
  for (const chunk of chunkByParams(annotationRows, TEST_ANNOTATIONS_COLUMNS)) {
    statements.push(db.insert(testAnnotations).values(chunk));
  }
  return { statements, mapping };
}

/**
 * Build the batch statements that prefill one queued test_results row per
 * planned test at openRun. Status = "queued", duration = 0, no errors. The
 * unique `(run_id, test_id)` index is what lets /results later upsert these
 * in place.
 */
function buildQueuePrefillStatements(
  db: Db,
  runId: string,
  plannedTests: ReadonlyArray<{
    testId: string;
    title: string;
    file: string;
    projectName?: string | null | undefined;
  }>,
  now: Date,
): BatchItem<"sqlite">[] {
  if (plannedTests.length === 0) return [];
  const rows: (typeof testResults.$inferInsert)[] = plannedTests.map((p) => ({
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
    createdAt: now,
  }));
  const statements: BatchItem<"sqlite">[] = [];
  for (const chunk of chunkByParams(rows, TEST_RESULTS_COLUMNS)) {
    statements.push(db.insert(testResults).values(chunk));
  }
  return statements;
}

async function runBatches(statements: BatchItem<"sqlite">[]): Promise<void> {
  const db = getDb();
  for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_BATCH) {
    const chunk = statements.slice(i, i + MAX_STATEMENTS_PER_BATCH) as [
      BatchItem<"sqlite">,
      ...BatchItem<"sqlite">[],
    ];
    await db.batch(chunk);
  }
}

async function resolveProjectScope(projectId: string) {
  const db = getDb();
  const [scope] = await db
    .select({ teamSlug: teams.slug, projectSlug: projects.slug })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return scope;
}

function runUrl(scope: { teamSlug: string; projectSlug: string }, id: string) {
  return `/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${id}`;
}

/**
 * POST /api/runs — open a streaming run.
 *
 * The run is visible (committed=true) from the moment it is opened so the
 * dashboard can render results as they stream in. Aggregates start at zero
 * and are recomputed on each /results append.
 *
 * Idempotent on (projectId, idempotencyKey): resending the same key returns
 * the existing runId rather than creating a duplicate run. This lets multiple
 * Playwright shards — each of which runs its own reporter — converge on one
 * run for a CI build.
 */
export async function openRunHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  const projectId = ctx.apiKey?.projectId;
  if (!projectId) return jsonResponse({ error: "Unauthorized" }, 401);

  let payload: OpenRunPayload;
  try {
    payload = OpenRunPayloadSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const scope = await resolveProjectScope(projectId);
  if (!scope) return jsonResponse({ error: "Unauthorized" }, 401);

  const db = getDb();

  const existing = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.idempotencyKey, payload.idempotencyKey),
      ),
    )
    .limit(1);
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
  const now = new Date();
  const plannedTests = payload.run.plannedTests ?? [];

  const openStatements: BatchItem<"sqlite">[] = [
    db.insert(runs).values({
      id: runId,
      projectId,
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
      // `totalTests` is the number of rows currently in `test_results`
      // for this run. With queue prefill it starts at plannedTests.length
      // and stays there as results upsert in place; `expectedTotalTests`
      // mirrors the same value for UI consistency.
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
      createdAt: now,
      completedAt: null,
      committed: true,
    }),
    ...buildQueuePrefillStatements(db, runId, plannedTests, now),
  ];
  await runBatches(openStatements);
  await broadcastRunProgress(runId, scope);

  return jsonResponse({ runId, runUrl: runUrl(scope, runId) }, 201);
}

/** Build a single UPDATE that recomputes run aggregates from test_results. */
function aggregateRecomputeStatement(
  db: ReturnType<typeof getDb>,
  runId: string,
): BatchItem<"sqlite"> {
  const idExpr = sql.raw(`'${runId.replace(/'/g, "''")}'`);
  // Derive counts in one statement — avoids a round-trip to SELECT first.
  return db
    .update(runs)
    .set({
      totalTests: sql`(SELECT COUNT(*) FROM test_results WHERE run_id = ${idExpr})`,
      passed: sql`(SELECT COUNT(*) FROM test_results WHERE run_id = ${idExpr} AND status = 'passed')`,
      failed: sql`(SELECT COUNT(*) FROM test_results WHERE run_id = ${idExpr} AND status IN ('failed', 'timedout'))`,
      flaky: sql`(SELECT COUNT(*) FROM test_results WHERE run_id = ${idExpr} AND status = 'flaky')`,
      skipped: sql`(SELECT COUNT(*) FROM test_results WHERE run_id = ${idExpr} AND status = 'skipped')`,
    })
    .where(eq(runs.id, runId));
}

/**
 * POST /api/runs/:id/results — append a batch of test results.
 *
 * Validates that the run belongs to this API key's project, then inserts
 * rows + recomputes aggregates in a single D1 batch. Returns the
 * clientKey → testResultId mapping so the reporter can fire per-test
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
  const projectId = ctx.apiKey?.projectId;
  if (!projectId) return jsonResponse({ error: "Unauthorized" }, 401);

  const runId = params.id;
  if (!runId) return jsonResponse({ error: "Not found" }, 404);

  let payload: AppendResultsPayload;
  try {
    payload = AppendResultsPayloadSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const db = getDb();
  const [owner] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
    .limit(1);
  if (!owner) return jsonResponse({ error: "Run not found" }, 404);

  const now = new Date();
  const testIds = payload.results.map((r) => r.testId);
  const { existingIds, assignedIds } = await resolveTestResultIds(
    db,
    runId,
    testIds,
  );
  const { statements, mapping } = buildResultInsertStatements(
    db,
    runId,
    payload.results,
    now,
    existingIds,
    assignedIds,
  );
  statements.push(aggregateRecomputeStatement(db, runId));
  await runBatches(statements);

  const scope = await resolveProjectScope(projectId);
  if (scope) await broadcastRunProgress(runId, scope);

  return jsonResponse({ results: mapping }, 200);
}

/**
 * POST /api/runs/:id/complete — finalize a streaming run.
 *
 * Sets the terminal status + completedAt + final durationMs, and does one
 * last aggregate recompute in case a straggler /results call raced with this.
 * Idempotent: a second call from another shard just re-sets the same values.
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
  const projectId = ctx.apiKey?.projectId;
  if (!projectId) return jsonResponse({ error: "Unauthorized" }, 401);

  const runId = params.id;
  if (!runId) return jsonResponse({ error: "Not found" }, 404);

  let payload: CompleteRunPayload;
  try {
    payload = CompleteRunPayloadSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const db = getDb();
  const [owner] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
    .limit(1);
  if (!owner) return jsonResponse({ error: "Run not found" }, 404);

  const now = new Date();
  await db.batch([
    db
      .update(runs)
      .set({
        status: payload.status,
        durationMs: payload.durationMs,
        completedAt: now,
      })
      .where(eq(runs.id, runId)),
    aggregateRecomputeStatement(db, runId),
  ]);

  const scope = await resolveProjectScope(projectId);
  if (scope) await broadcastRunProgress(runId, scope);

  return jsonResponse({ runId, status: payload.status }, 200);
}
