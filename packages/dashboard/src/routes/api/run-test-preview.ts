import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { runs, testResults } from "@/db/schema";
import { resolveProjectBySlugs } from "@/lib/authz";
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
 * Returns up to 5 test results per category (failed, flaky, passed, skipped)
 * for the given run. Used by the runs list badge popovers. Totals already
 * live on the runs row on the client, so we don't echo them back.
 *
 * Tenancy is enforced via the runs.projectId predicate on every sub-query.
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

  const project = await resolveProjectBySlugs(
    ctx.user.id,
    teamSlug,
    projectSlug,
  );
  if (!project) return new Response("Not found", { status: 404 });

  const db = getDb();

  const results = await Promise.all(
    BUCKETS.map((bucket) =>
      db
        .select({
          id: testResults.id,
          title: testResults.title,
          file: testResults.file,
          projectName: testResults.projectName,
          status: testResults.status,
          errorMessage: testResults.errorMessage,
        })
        .from(testResults)
        .innerJoin(runs, eq(runs.id, testResults.runId))
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.projectId, project.id),
            inArray(testResults.status, bucket.statuses),
          ),
        )
        .orderBy(testResults.file, testResults.title)
        .limit(PREVIEW_LIMIT),
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
