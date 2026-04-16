import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb } from "@/db";
import {
  runs,
  testResults,
  testTags,
  testAnnotations,
} from "@/db/schema";
import { IngestPayloadSchema, type IngestPayload } from "./schemas";

const MAX_STATEMENTS_PER_BATCH = 900;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function ingestHandler({
  request,
}: {
  request: Request;
}) {
  let payload: IngestPayload;
  try {
    const body = await request.json();
    payload = IngestPayloadSchema.parse(body);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid request body";
    return jsonResponse({ error: "Validation failed", details: message }, 400);
  }

  const db = getDb();

  // Check idempotency
  const existing = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.idempotencyKey, payload.idempotencyKey))
    .limit(1);

  if (existing.length > 0) {
    return jsonResponse(
      {
        runId: existing[0].id,
        runUrl: `/runs/${existing[0].id}`,
        duplicate: true,
      },
      200,
    );
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

  // Insert run
  await db.insert(runs).values({
    id: runId,
    idempotencyKey: payload.idempotencyKey,
    ciProvider: payload.run.ciProvider ?? null,
    ciBuildId: payload.run.ciBuildId ?? null,
    branch: payload.run.branch ?? null,
    commitSha: payload.run.commitSha ?? null,
    commitMessage: payload.run.commitMessage ?? null,
    prNumber: payload.run.prNumber ?? null,
    repo: payload.run.repo ?? null,
    shardIndex: payload.run.shardIndex ?? null,
    shardTotal: payload.run.shardTotal ?? null,
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
  });

  // Prepare test results, tags, and annotations with generated IDs
  const resultRows: (typeof testResults.$inferInsert)[] = [];
  const tagRows: (typeof testTags.$inferInsert)[] = [];
  const annotationRows: (typeof testAnnotations.$inferInsert)[] = [];

  for (const result of payload.results) {
    const testResultId = ulid();

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

  // Batch insert test results in chunks
  // D1 has a 1000 statement limit per batch
  for (let i = 0; i < resultRows.length; i += MAX_STATEMENTS_PER_BATCH) {
    const chunk = resultRows.slice(i, i + MAX_STATEMENTS_PER_BATCH);
    await db.insert(testResults).values(chunk);
  }

  // Batch insert tags
  if (tagRows.length > 0) {
    for (let i = 0; i < tagRows.length; i += MAX_STATEMENTS_PER_BATCH) {
      const chunk = tagRows.slice(i, i + MAX_STATEMENTS_PER_BATCH);
      await db.insert(testTags).values(chunk);
    }
  }

  // Batch insert annotations
  if (annotationRows.length > 0) {
    for (
      let i = 0;
      i < annotationRows.length;
      i += MAX_STATEMENTS_PER_BATCH
    ) {
      const chunk = annotationRows.slice(i, i + MAX_STATEMENTS_PER_BATCH);
      await db.insert(testAnnotations).values(chunk);
    }
  }

  return jsonResponse(
    {
      runId,
      runUrl: `/runs/${runId}`,
    },
    201,
  );
}
