import { tenantScopeForUser } from "@/tenant";
import type { AppContext } from "@/worker";

export type RunSummaryResponse = {
  id: string;
  status: string;
  durationMs: number;
  totalTests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  actor: string | null;
  createdAt: number;
  completedAt: number | null;
};

function jsonResponse(body: unknown, status: number, cacheControl?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/summary
 *
 * Returns a compact snapshot of a single run for the run-history chart
 * hovercard. Totals, branch, commit, author. Does not include per-test
 * detail — that lives on `/test-preview`.
 */
export async function runSummaryHandler({
  params,
  ctx,
}: {
  request: Request;
  params: Record<string, string>;
  ctx: AppContext;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const { teamSlug, projectSlug, runId } = params;
  if (!teamSlug || !projectSlug || !runId) {
    return new Response("Not found", { status: 404 });
  }

  const scope = await tenantScopeForUser(ctx.user.id, teamSlug, projectSlug);
  if (!scope) return new Response("Not found", { status: 404 });

  const run = await scope.db
    .selectFrom("runs")
    .select([
      "id",
      "status",
      "durationMs",
      "totalTests",
      "passed",
      "failed",
      "flaky",
      "skipped",
      "branch",
      "commitSha",
      "commitMessage",
      "prNumber",
      "actor",
      "createdAt",
      "completedAt",
    ])
    .where("id", "=", runId)
    .where("projectId", "=", scope.projectId)
    .executeTakeFirst();

  if (!run) return new Response("Not found", { status: 404 });

  const body: RunSummaryResponse = run;
  return jsonResponse(body, 200, "private, max-age=30");
}
