import { defineHandler } from "void";
import { and, db, eq } from "void/db";
import { runs } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { AppendResultsPayloadSchema } from "@/lib/schemas";
import {
  aggregateDeltaStatement,
  aggregateSummarySelectStatement,
  broadcastRunUpdate,
  buildChangedTests,
  buildResultInsertStatements,
  bumpTeamActivity,
  computeAggregateDelta,
  resolveTestResultIds,
  type RunAggregateSummary,
} from "@/lib/ingest";

/**
 * POST /api/runs/:id/results — append a batch of test results.
 *
 * Atomic per-batch transaction: testResults upsert + tag/annotation replace
 * + per-attempt insert + aggregate delta, all in one D1 batch. Returns the
 * clientKey → testResultId mapping so the reporter can fan out per-test
 * artifact uploads as tests complete.
 */
export const POST = defineHandler.withValidator({
  body: AppendResultsPayloadSchema,
})(async (c, { body: payload }) => {
  const runId = c.req.param("id");
  if (!runId) return c.json({ error: "Not found" }, 404);

  const scope = await tenantScopeForApiKey(getApiKey(c));

  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, runId)))
    .limit(1);
  if (!owner[0]) return c.json({ error: "Run not found" }, 404);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const testIds = payload.results.map((r) => r.testId);
  const { existingIds, assignedIds, prevStatusByTestId } =
    await resolveTestResultIds(scope, runId, testIds);
  const { statements, mapping } = buildResultInsertStatements(
    scope,
    runId,
    payload.results,
    nowSeconds,
    existingIds,
    assignedIds,
  );
  const deltaStmt = aggregateDeltaStatement(
    scope,
    runId,
    computeAggregateDelta(payload.results, prevStatusByTestId),
  );
  // Always finish the batch with a statement that returns the publishable
  // summary — `.returning()` on the delta UPDATE when there is one, otherwise
  // a plain SELECT. Both run inside the D1 batch so the snapshot we broadcast
  // is transactionally consistent with the per-test writes.
  const summaryStmt =
    deltaStmt ?? aggregateSummarySelectStatement(scope, runId);
  statements.push(summaryStmt as never);
  const batchResults = (await db.batch(
    statements as never,
  )) as readonly unknown[];
  await bumpTeamActivity(scope.teamId, nowSeconds);

  const summaryRows = batchResults[batchResults.length - 1] as
    | readonly RunAggregateSummary[]
    | undefined;
  const summary = summaryRows?.[0];
  if (!summary) return c.json({ error: "Run not found" }, 404);

  const changedTests = buildChangedTests(payload.results, assignedIds);
  await broadcastRunUpdate(runId, changedTests, summary);

  return c.json({ results: mapping }, 200);
});
