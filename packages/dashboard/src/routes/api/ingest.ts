import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ulid } from "ulid";
import { getDb } from "@/db";
import {
  projects,
  runs,
  teams,
  testResults,
  testTags,
  testAnnotations,
} from "@/db/schema";
import { IngestPayloadSchema, type IngestPayload } from "./schemas";
import type { AppContext } from "@/worker";

// D1 caps: 100 bound parameters per query, 1000 queries per batch. We chunk
// each child table's rows so no multi-row insert exceeds the param cap. We
// then split those statements across however many 1000-statement batches the
// payload requires.
//
// Atomicity across batches is provided by the `runs.committed` flag rather
// than D1: the runs row is inserted with committed=false in the first batch,
// every child batch commits independently, and a final batch flips committed
// to true. All reads filter `committed = 1`, so a mid-ingest failure leaves
// the partial run invisible. A retry hits the idempotency guard, which
// detects the uncommitted row and deletes it (FK cascade cleans children)
// before restarting.
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

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function ingestHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  const projectId = ctx.apiKey?.projectId;
  if (!projectId) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload: IngestPayload;
  try {
    const body = await request.json();
    payload = IngestPayloadSchema.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const db = getDb();

  // Resolve the team+project slugs once so every response below can return a
  // scoped runUrl that the CLI can print as a clickable link.
  const [scope] = await db
    .select({ teamSlug: teams.slug, projectSlug: projects.slug })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!scope) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const runUrl = (id: string) =>
    `/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${id}`;

  // Idempotency is scoped to a project. A committed row wins; an uncommitted
  // one is a prior failed ingest and gets torn down so this call can retry.
  const existing = await db
    .select({ id: runs.id, committed: runs.committed })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.idempotencyKey, payload.idempotencyKey),
      ),
    )
    .limit(1);

  if (existing.length > 0 && existing[0].committed) {
    return jsonResponse(
      {
        runId: existing[0].id,
        runUrl: runUrl(existing[0].id),
        duplicate: true,
      },
      200,
    );
  }
  if (existing.length > 0) {
    // Stale uncommitted row — cascade-deletes test_results / tags /
    // annotations / artifacts so we can re-insert cleanly.
    await db.delete(runs).where(eq(runs.id, existing[0].id));
  }

  const runId = ulid();
  const now = new Date();

  // Compute aggregates from results
  let totalTests = payload.results.length;
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;

  for (const r of payload.results) {
    switch (r.status) {
      case "passed":
        passed++;
        break;
      case "failed":
      case "timedout":
        failed++;
        break;
      case "flaky":
        flaky++;
        break;
      case "skipped":
        skipped++;
        break;
    }
  }

  // Prepare test results, tags, and annotations with generated IDs.
  // We also build a clientKey -> testResultId mapping so the CLI can later
  // attach artifacts to the correct row (protocol v2).
  const resultRows: (typeof testResults.$inferInsert)[] = [];
  const tagRows: (typeof testTags.$inferInsert)[] = [];
  const annotationRows: (typeof testAnnotations.$inferInsert)[] = [];
  const resultMapping: Array<{ clientKey: string; testResultId: string }> = [];

  for (const result of payload.results) {
    const testResultId = ulid();

    if (result.clientKey) {
      resultMapping.push({ clientKey: result.clientKey, testResultId });
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
      tagRows.push({
        id: ulid(),
        testResultId,
        tag,
      });
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

  const statements: BatchItem<"sqlite">[] = [
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
      totalTests,
      passed,
      failed,
      flaky,
      skipped,
      durationMs: payload.run.durationMs,
      status: payload.run.status,
      reporterVersion: payload.run.reporterVersion ?? null,
      playwrightVersion: payload.run.playwrightVersion ?? null,
      createdAt: now,
      committed: false,
    }),
  ];
  for (const chunk of chunkByParams(resultRows, TEST_RESULTS_COLUMNS)) {
    statements.push(db.insert(testResults).values(chunk));
  }
  for (const chunk of chunkByParams(tagRows, TEST_TAGS_COLUMNS)) {
    statements.push(db.insert(testTags).values(chunk));
  }
  for (const chunk of chunkByParams(annotationRows, TEST_ANNOTATIONS_COLUMNS)) {
    statements.push(db.insert(testAnnotations).values(chunk));
  }
  // The commit flip is the last statement of the last batch: any failure
  // before this point leaves committed=false and the row stays invisible.
  statements.push(
    db.update(runs).set({ committed: true }).where(eq(runs.id, runId)),
  );

  for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_BATCH) {
    const chunk = statements.slice(i, i + MAX_STATEMENTS_PER_BATCH) as [
      BatchItem<"sqlite">,
      ...BatchItem<"sqlite">[],
    ];
    await db.batch(chunk);
  }

  return jsonResponse(
    {
      runId,
      runUrl: runUrl(runId),
      results: resultMapping,
    },
    201,
  );
}
