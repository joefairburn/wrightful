import { tenantScopeForUser } from "@/tenant";
import type { AppContext } from "@/worker";

export type TestResultSummaryResponse = {
  id: string;
  runId: string;
  status: string;
  durationMs: number;
  retryCount: number;
  title: string;
  file: string;
  projectName: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  actor: string | null;
  createdAt: number;
};

function jsonResponse(body: unknown, status: number, cacheControl?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/summary
 *
 * Test-scoped companion to `runSummaryHandler`. Used by the history-chart
 * hovercard on the Test Detail page, where the bar represents a single
 * `testResult` occurrence rather than a whole run.
 */
export async function testResultSummaryHandler({
  params,
  ctx,
}: {
  request: Request;
  params: Record<string, string>;
  ctx: AppContext;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const { teamSlug, projectSlug, runId, testResultId } = params;
  if (!teamSlug || !projectSlug || !runId || !testResultId) {
    return new Response("Not found", { status: 404 });
  }

  const scope = await tenantScopeForUser(ctx.user.id, teamSlug, projectSlug);
  if (!scope) return new Response("Not found", { status: 404 });

  const row = await scope.db
    .selectFrom("testResults")
    .innerJoin("runs", "runs.id", "testResults.runId")
    .select([
      "testResults.id as id",
      "testResults.runId as runId",
      "testResults.status as status",
      "testResults.durationMs as durationMs",
      "testResults.retryCount as retryCount",
      "testResults.title as title",
      "testResults.file as file",
      "testResults.projectName as projectName",
      "testResults.createdAt as createdAt",
      "runs.branch as branch",
      "runs.commitSha as commitSha",
      "runs.commitMessage as commitMessage",
      "runs.actor as actor",
    ])
    .where("testResults.id", "=", testResultId)
    .where("testResults.runId", "=", runId)
    .where("runs.projectId", "=", scope.projectId)
    .executeTakeFirst();

  if (!row) return new Response("Not found", { status: 404 });

  const body: TestResultSummaryResponse = row;
  return jsonResponse(body, 200, "private, max-age=30");
}
