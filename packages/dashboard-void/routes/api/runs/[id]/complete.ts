import { defineHandler } from "void";
import { and, db, eq } from "void/db";
import { runs } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { CompleteRunPayloadSchema } from "@/lib/schemas";
import {
  aggregateRecomputeStatement,
  broadcastRunUpdate,
  bumpTeamActivity,
  type RunAggregateSummary,
} from "@/lib/ingest";

function backdatingAllowed(): boolean {
  return Boolean(import.meta.env?.VITE_IS_DEV_SERVER);
}

/**
 * POST /api/runs/:id/complete — finalize a streaming run.
 *
 * Sets the terminal status, durationMs, completedAt, and does one final
 * aggregate recompute to reconcile any straggler /results writes that
 * raced this call. Idempotent — a second shard calling complete just
 * re-sets the same values.
 */
export const POST = defineHandler.withValidator({
  body: CompleteRunPayloadSchema,
})(async (c, { body: payload }) => {
  const runId = c.req.param("id");
  if (!runId) return c.json({ error: "Not found" }, 404);

  if (payload.completedAt !== undefined && !backdatingAllowed()) {
    return c.json(
      { error: "completedAt override is only allowed in local development" },
      400,
    );
  }

  const scope = await tenantScopeForApiKey(getApiKey(c));
  const owner = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, runId)))
    .limit(1);
  if (!owner[0]) return c.json({ error: "Run not found" }, 404);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const completedAt =
    payload.completedAt !== undefined ? payload.completedAt : nowSeconds;
  // Aggregate recompute is last so its `.returning()` row is the final entry
  // in the batch result array — that's the source of truth for the broadcast.
  const batchResults = (await db.batch([
    db
      .update(runs)
      .set({
        status: payload.status,
        durationMs: payload.durationMs,
        completedAt,
      })
      .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, runId))),
    aggregateRecomputeStatement(scope, runId),
  ] as never)) as readonly unknown[];
  await bumpTeamActivity(scope.teamId, nowSeconds);

  const summaryRows = batchResults[batchResults.length - 1] as
    | readonly RunAggregateSummary[]
    | undefined;
  const summary = summaryRows?.[0];
  if (summary) {
    await broadcastRunUpdate(runId, [], summary);
  }

  return c.json({ runId, status: payload.status }, 200);
});
