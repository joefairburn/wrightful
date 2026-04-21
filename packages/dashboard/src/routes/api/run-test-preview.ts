import { tenantScopeForUser } from "@/tenant";
import type { AppContext } from "@/worker";

const PREVIEW_LIMIT = 5;

export type TestPreviewItem = {
  id: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  errorMessage: string | null;
};

export type TestPreviewResponse = {
  failed: TestPreviewItem[];
  flaky: TestPreviewItem[];
  passed: TestPreviewItem[];
  skipped: TestPreviewItem[];
};

type BucketKey = keyof TestPreviewResponse;

const BUCKETS: Array<{ key: BucketKey; statuses: string[] }> = [
  { key: "failed", statuses: ["failed", "timedout"] },
  { key: "flaky", statuses: ["flaky"] },
  { key: "passed", statuses: ["passed"] },
  { key: "skipped", statuses: ["skipped"] },
];

function jsonResponse(body: unknown, status: number, cacheControl?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview
 *
 * Returns up to 5 test results per category (failed, flaky, passed,
 * skipped) for the given run. Used by the runs list badge popovers.
 * Totals already live on the runs row on the client, so we don't echo
 * them back. Tenancy is enforced by `tenantScopeForUser` (membership
 * check on the session user) plus `runs.projectId` + `runs.committed = 1`
 * predicates on each sub-query.
 */
export async function runTestPreviewHandler({
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

  const results = await Promise.all(
    BUCKETS.map((bucket) =>
      scope.db
        .selectFrom("testResults")
        .innerJoin("runs", "runs.id", "testResults.runId")
        .select([
          "testResults.id as id",
          "testResults.title as title",
          "testResults.file as file",
          "testResults.projectName as projectName",
          "testResults.status as status",
          "testResults.errorMessage as errorMessage",
        ])
        .where("runs.id", "=", runId)
        .where("runs.projectId", "=", scope.projectId)
        .where("runs.committed", "=", 1)
        .where("testResults.status", "in", bucket.statuses)
        .orderBy("testResults.file", "asc")
        .orderBy("testResults.title", "asc")
        .limit(PREVIEW_LIMIT)
        .execute(),
    ),
  );

  const body: TestPreviewResponse = {
    failed: results[0],
    flaky: results[1],
    passed: results[2],
    skipped: results[3],
  };

  return jsonResponse(body, 200, "private, max-age=15");
}
