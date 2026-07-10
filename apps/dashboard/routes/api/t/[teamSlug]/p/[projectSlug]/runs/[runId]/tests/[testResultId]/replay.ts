import { defineHandler } from "void";
import { and, db, desc, eq } from "void/db";
import { env } from "void/env";
import { artifacts, testResults } from "@schema";
import {
  TRACE_TOKEN_TTL_SECONDS,
  signArtifactToken,
  signedDownloadHref,
  signedTraceViewerUrl,
} from "@/lib/artifact-tokens";
import { resolvePublicOrigin } from "@/lib/config";
import { childByTestResultWhere, childProjectScopeWhere } from "@/lib/scope";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

export type TestReplayResponse = {
  /**
   * Self-hosted trace-viewer URL with a freshly-signed `?trace=` token, for
   * the LAST attempt (kept alongside `attempts` for e2e/back-compat — earlier
   * deep-links only ever knew about the final run).
   */
  traceViewerUrl: string;
  /** Signed direct download of the raw `trace.zip`, for the LAST attempt. */
  downloadHref: string;
  /** The test's title, so a deep-linked modal can render its header. */
  title: string;
  /**
   * Every attempt that recorded a trace, ascending by `attempt` (0-based).
   * Drives the modal's attempt switcher when a test retried; each entry gets
   * its own freshly-signed token.
   */
  attempts: Array<{
    attempt: number;
    traceViewerUrl: string;
    downloadHref: string;
  }>;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/replay
 *
 * Lazily mints Replay (trace-viewer) URLs for one test — one per attempt that
 * recorded a trace (there are at most a handful of retries). The run's
 * Tests-tab list carries only minimal per-test rows — no artifact rows, no
 * signed URLs — so the per-row "Replay" button (and any
 * `?replay=<testResultId>` deep-link) fetches here. Minting on demand (rather
 * than pre-signing every row in the loader) keeps the download tokens fresh
 * and avoids embedding one per test in the page.
 *
 * The top-level `traceViewerUrl`/`downloadHref` describe the LAST attempt
 * (highest `attempt`) — the final, authoritative run of the test; `attempts`
 * carries all of them (ascending) so the modal can offer a switcher. Every
 * trace token — top-level and per-attempt — is signed with
 * `TRACE_TOKEN_TTL_SECONDS` rather than the shorter default: see that
 * constant's docstring for why (the SW range-reads the trace lazily, so a
 * short-lived token would start failing quietly mid-scrub).
 *
 * 404 when the test recorded no trace at all (e.g. a passed test under the
 * reporter's default `artifacts: "failed"` mode).
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
      attempt: artifacts.attempt,
    })
    .from(artifacts)
    .where(
      and(
        childByTestResultWhere(artifacts, scope, testResultId),
        eq(artifacts.type, "trace"),
      ),
    )
    .orderBy(desc(artifacts.attempt));

  const last = rows[0];
  if (!last) return c.json({ error: "No trace recorded for this test" }, 404);

  // The test title for the modal header (the rows already scoped the
  // artifacts, so this is the same project + the test's own id).
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

  // Canonical https origin: the self-hosted viewer (an https page) fetches this
  // absolute trace URL, so an http one behind Cloudflare trips `connect-src 'self'`.
  const origin = resolvePublicOrigin(env, new URL(c.req.url).origin);

  // Ascending by attempt for the modal's switcher (`rows` came back descending
  // so `last` above is cheap); each attempt gets its own freshly-signed token.
  const attempts = await Promise.all(
    [...rows]
      .sort((a, b) => a.attempt - b.attempt)
      .map(async (row) => {
        const token = await signArtifactToken(
          { r2Key: row.r2Key, contentType: row.contentType },
          TRACE_TOKEN_TTL_SECONDS,
        );
        return {
          attempt: row.attempt,
          traceViewerUrl: signedTraceViewerUrl(origin, row.id, token),
          downloadHref: signedDownloadHref(row.id, token),
        };
      }),
  );
  // `attempts` is non-empty because `rows` is (guarded via `last` above), so
  // the last entry (highest attempt, since we just sorted ascending) exists.
  const lastEntry = attempts[attempts.length - 1] as (typeof attempts)[number];

  c.header("Cache-Control", "private, no-store");
  return {
    traceViewerUrl: lastEntry.traceViewerUrl,
    downloadHref: lastEntry.downloadHref,
    title: titleRow[0]?.title ?? "Trace",
    attempts,
  } satisfies TestReplayResponse;
});
