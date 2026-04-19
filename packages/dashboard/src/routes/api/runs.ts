import { and, eq, sql } from "drizzle-orm";
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
 * Build batch statements that insert test_results + tags + annotations for a
 * run, chunked to respect D1's per-statement parameter cap. Returns the
 * clientKey → testResultId mapping so the caller can return it to the client.
 */
function buildResultInsertStatements(
  db: Db,
  runId: string,
  results: TestResultInput[],
  now: Date,
): { statements: BatchItem<"sqlite">[]; mapping: ResultMapping[] } {
  const resultRows: (typeof testResults.$inferInsert)[] = [];
  const tagRows: (typeof testTags.$inferInsert)[] = [];
  const annotationRows: (typeof testAnnotations.$inferInsert)[] = [];
  const mapping: ResultMapping[] = [];

  for (const result of results) {
    const testResultId = ulid();
    if (result.clientKey) {
      mapping.push({ clientKey: result.clientKey, testResultId });
    }
    resultRows.push({
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

  const statements: BatchItem<"sqlite">[] = [];
  for (const chunk of chunkByParams(resultRows, TEST_RESULTS_COLUMNS)) {
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
  await db.insert(runs).values({
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
    totalTests: 0,
    expectedTotalTests: payload.run.expectedTotalTests ?? null,
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
  });

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
  const { statements, mapping } = buildResultInsertStatements(
    db,
    runId,
    payload.results,
    now,
  );
  statements.push(aggregateRecomputeStatement(db, runId));
  await runBatches(statements);

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

  return jsonResponse({ runId, status: payload.status }, 200);
}
