import { defineHandler } from "void";
import { db } from "void/db";
import { runs } from "@schema";
import { getApiKey } from "@/lib/api-auth";
import { runByIdWhere, tenantScopeForApiKey } from "@/lib/scope";

/**
 * GET /api/v1/runs/:runId — public, Bearer-authed single-run summary.
 *
 * Project-scoped via `tenantScopeForApiKey` + `runByIdWhere(scope, runId)`: the
 * `(projectId, runId)` predicate means a run id belonging to another project
 * simply doesn't match → 404 (never leaks existence). The column projection
 * mirrors the in-dashboard `runs/:runId/summary` route's shape, extended with
 * the export-relevant `environment` / `repo` / `origin` fields.
 */
export const GET = defineHandler(async (c) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));
  const runId = c.req.param("runId");
  if (!runId) return c.json({ error: "Not found" }, 404);

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      branch: runs.branch,
      environment: runs.environment,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      prNumber: runs.prNumber,
      actor: runs.actor,
      repo: runs.repo,
      origin: runs.origin,
      totalTests: runs.totalTests,
      // Declared suite size from the reporter's onBegin (summed across shards
      // on a sharded run); null on legacy rows. Lets an API consumer detect a
      // partially-run suite: totalTests < expectedTotalTests ⇒ tests never ran.
      expectedTotalTests: runs.expectedTotalTests,
      passed: runs.passed,
      failed: runs.failed,
      flaky: runs.flaky,
      skipped: runs.skipped,
      durationMs: runs.durationMs,
      createdAt: runs.createdAt,
      completedAt: runs.completedAt,
    })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);

  const run = rows[0];
  if (!run) return c.json({ error: "Not found" }, 404);

  return c.json(run);
});
