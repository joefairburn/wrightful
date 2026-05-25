import { defineHandler } from "void";
import { and, db, eq } from "void/db";
import { ulid } from "ulid";
import { runs } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { OpenRunPayloadSchema } from "@/lib/schemas";
import {
  broadcastRunUpdate,
  buildQueuePrefillStatements,
  bumpTeamActivity,
} from "@/lib/ingest";
import type { RunAggregateSummary } from "@/lib/ingest";

function runUrl(scope: { teamSlug: string; projectSlug: string }, id: string) {
  return `/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${id}`;
}

function backdatingAllowed(): boolean {
  return Boolean(import.meta.env?.VITE_IS_DEV_SERVER);
}

/**
 * POST /api/runs — open a streaming run.
 *
 * Idempotent on (projectId, idempotencyKey). Returns the existing runId
 * when the same key is resent — lets multiple Playwright shards converge
 * on one run for a CI build.
 *
 * Auth + version negotiation run in `middleware/02.api-auth.ts`, which sets
 * `c.var.apiKey` before the handler executes.
 */
export const POST = defineHandler.withValidator({
  body: OpenRunPayloadSchema,
})(async (c, { body: payload }) => {
  if (payload.createdAt !== undefined && !backdatingAllowed()) {
    return c.json(
      { error: "createdAt override is only allowed in local development" },
      400,
    );
  }

  const scope = await tenantScopeForApiKey(getApiKey(c));

  const existing = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, scope.projectId),
        eq(runs.idempotencyKey, payload.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return c.json(
      {
        runId: existing[0].id,
        runUrl: runUrl(scope, existing[0].id),
        duplicate: true,
      },
      200,
    );
  }

  const runId = ulid();
  const nowSeconds =
    payload.createdAt !== undefined
      ? payload.createdAt
      : Math.floor(Date.now() / 1000);
  const plannedTests = payload.run.plannedTests ?? [];

  const runInsert = db.insert(runs).values({
    id: runId,
    teamId: scope.teamId,
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
  });

  const stmts = [
    runInsert,
    ...buildQueuePrefillStatements(scope, runId, plannedTests, nowSeconds),
  ];
  if (stmts.length === 1) {
    await stmts[0];
  } else {
    // D1 batch atomicity: all-or-nothing.
    await db.batch(stmts as never);
  }
  await bumpTeamActivity(scope.teamId, nowSeconds);

  // Synthesize the summary inline — we just inserted this row, no DB read needed.
  const summary: RunAggregateSummary = {
    totalTests: plannedTests.length,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    completedAt: null,
  };
  await broadcastRunUpdate(runId, [], summary);

  return c.json({ runId, runUrl: runUrl(scope, runId) }, 201);
});
