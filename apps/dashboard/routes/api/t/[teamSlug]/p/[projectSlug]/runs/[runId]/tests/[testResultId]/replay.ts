import { defineHandler } from "void";
import { and, db, desc, eq } from "void/db";
import { artifacts, testResults } from "@schema";
import {
  signArtifactToken,
  signedDownloadHref,
  signedTraceViewerUrl,
} from "@/lib/artifact-tokens";
import { childByTestResultWhere, childProjectScopeWhere } from "@/lib/scope";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

export type TestReplayResponse = {
  /** Self-hosted trace-viewer URL with a freshly-signed `?trace=` token. */
  traceViewerUrl: string;
  /** Signed direct download of the raw `trace.zip`. */
  downloadHref: string;
  /** The test's title, so a deep-linked modal can render its header. */
  title: string;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/replay
 *
 * Lazily mints a Replay (trace-viewer) URL for one test. The run's Tests-tab
 * list carries only minimal per-test rows — no artifact rows, no signed URLs —
 * so the per-row "Replay" button (and any `?replay=<testResultId>` deep-link)
 * fetches here. Minting on demand (rather than pre-signing every row in the
 * loader) keeps the download token fresh (1h TTL) and avoids embedding a token
 * per test in the page.
 *
 * Returns the trace of the LAST attempt (highest `attempt`) — the final,
 * authoritative run of the test. 404 when the test recorded no trace (e.g. a
 * passed test under the reporter's default `artifacts: "failed"` mode).
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c, { requireTestResultId: true });
  if (ctx instanceof Response) return ctx;
  const { scope, testResultId } = ctx;

  const rows = await db
    .select({
      id: artifacts.id,
      r2Key: artifacts.r2Key,
      contentType: artifacts.contentType,
    })
    .from(artifacts)
    .where(
      and(
        childByTestResultWhere(artifacts, scope, testResultId),
        eq(artifacts.type, "trace"),
      ),
    )
    .orderBy(desc(artifacts.attempt))
    .limit(1);

  const row = rows[0];
  if (!row) return c.json({ error: "No trace recorded for this test" }, 404);

  // The test title for the modal header (the row already scoped the artifact,
  // so this is the same project + the row's own id).
  const titleRow = await db
    .select({ title: testResults.title })
    .from(testResults)
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        eq(testResults.id, testResultId),
      ),
    )
    .limit(1);

  const token = await signArtifactToken({
    r2Key: row.r2Key,
    contentType: row.contentType,
  });
  const origin = new URL(c.req.url).origin;
  c.header("Cache-Control", "private, no-store");
  return {
    traceViewerUrl: signedTraceViewerUrl(origin, row.id, token),
    downloadHref: signedDownloadHref(row.id, token),
    title: titleRow[0]?.title ?? "Trace",
  } satisfies TestReplayResponse;
});
