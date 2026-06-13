import { defineHandler, type InferProps } from "void";
import { db, eq } from "void/db";
import { runShares, runs } from "@schema";
import { loadRunResultsPage } from "@/lib/run-results-page";
import { makeTenantScope, runByIdWhere } from "@/lib/scope";
import { shareTokenHash, verifyShareToken } from "@/lib/share-tokens";

const TESTS_LIMIT = 200;

export type Props = InferProps<typeof loader>;

/**
 * Public, read-only run view behind a signed share token (`/share/run/:token`).
 * Renders anonymously — the `/share/*` path isn't gated by `middleware/01.context`
 * (only `/t/*` and `/settings` redirect anonymous visitors to /login).
 *
 * Auth is the token itself: `verifyShareToken` proves HMAC authenticity + expiry
 * statelessly, then a `runShares` row lookup enforces per-link revocation. The
 * verified ids are laundered into a `TenantScope` via `makeTenantScope` — a
 * sanctioned producer (ids proven by HMAC, not by membership). No tenant URLs
 * are built here, so the scope's slugs are intentionally empty.
 */
export const loader = defineHandler(async (c) => {
  const token = c.req.param("token");
  if (!token) return { valid: false as const };

  const payload = await verifyShareToken(token);
  if (!payload) return { valid: false as const };

  const shareRows = await db
    .select({ revokedAt: runShares.revokedAt })
    .from(runShares)
    .where(eq(runShares.tokenHash, await shareTokenHash(token)))
    .limit(1);
  const share = shareRows[0];
  if (!share || share.revokedAt !== null) return { valid: false as const };

  const scope = makeTenantScope({
    teamId: payload.teamId,
    projectId: payload.projectId,
    teamSlug: "",
    projectSlug: "",
  });

  const runRows = await db
    .select({
      status: runs.status,
      passed: runs.passed,
      failed: runs.failed,
      flaky: runs.flaky,
      skipped: runs.skipped,
      totalTests: runs.totalTests,
      durationMs: runs.durationMs,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      environment: runs.environment,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(runByIdWhere(scope, payload.runId))
    .limit(1);
  const run = runRows[0];
  if (!run) return { valid: false as const };

  const resultsPage = await loadRunResultsPage(scope, payload.runId, {
    cursor: null,
    limit: TESTS_LIMIT,
    status: null,
  });

  return {
    valid: true as const,
    run,
    tests: resultsPage?.results ?? [],
  };
});
