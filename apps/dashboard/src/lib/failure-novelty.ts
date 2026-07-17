import { and, db, inArray, isNotNull, lt } from "void/db";
import { runs, testResults } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import {
  childProjectScopeWhere,
  runByIdWhere,
  type TenantScope,
} from "@/lib/scope";
import type { RunProgressTest } from "@/realtime/run-progress";

/**
 * Classify a page of a run's failure rows as NEW (this run is the failure
 * fingerprint's first CI appearance) or known (the same `errorSignature` was
 * seen in an earlier run). Returns `testResultId → isNewFailure` for exactly
 * the rows that could be classified — failures whose ingest-persisted
 * signature is non-null; passing/queued rows and errorless failures are
 * absent, and the row's `isNewFailure` stays undefined.
 *
 * "Earlier" means an occurrence with `createdAt < run.createdAt` in CI
 * (synthetic monitor traffic excluded, matching the Failures page's
 * first-seen definition in `analytics/failures.ts`). Novelty is therefore a
 * CI-only concept, so a SYNTHETIC run's rows are never classified: run-detail
 * pages serve monitor runs too (`runByIdWhere` deliberately sees them), and
 * judging those rows against CI history would badge a recurring monitor
 * failure "New" on every execution forever. Two runs racing the same
 * brand-new failure can both classify as new — the honest reading. Like
 * `hasTrace` (see `trace-presence.ts`), this is a UI-only enrichment applied
 * by the run-detail `…/results` route on the paginated read, kept OUT of the
 * shared `loadRunResultsPage` so it never leaks into the public v1 / export /
 * MCP contracts; live-broadcast rows carry no flag until the next fetch.
 */
export async function loadNewFailureFlags(
  scope: TenantScope,
  runId: string,
  rows: readonly RunProgressTest[],
): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>();
  if (rows.length === 0) return flags;

  // The page rows' shared projection deliberately omits `errorSignature`
  // (public-contract shape), so re-read it for just this page's ids alongside
  // the run's createdAt — one wave, both cheap indexed reads.
  const ids = rows.map((r) => r.id);
  const [runRows, sigRows] = await Promise.all([
    db
      .select({ createdAt: runs.createdAt, origin: runs.origin })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .limit(1),
    db
      .select({ id: testResults.id, signature: testResults.errorSignature })
      .from(testResults)
      .where(
        and(
          childProjectScopeWhere(testResults.projectId, scope),
          inArray(testResults.id, ids),
          isNotNull(testResults.errorSignature),
        ),
      ),
  ]);
  const run = runRows[0];
  if (!run || run.origin === "synthetic" || sigRows.length === 0) return flags;

  // A signature is KNOWN iff any CI occurrence predates this run's open time.
  // Every one of this run's own rows has createdAt >= run.createdAt (createdAt
  // is insert-only, set at the queued prefill or first streamed result), so
  // the run's own occurrences can never mark it known.
  const signatures = [...new Set(sigRows.map((r) => r.signature!))];
  const priorRows = await db
    .selectDistinct({ signature: testResults.errorSignature })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        inArray(testResults.errorSignature, signatures),
        lt(testResults.createdAt, run.createdAt),
      ),
    );
  const known = new Set(priorRows.map((r) => r.signature));

  for (const row of sigRows) {
    flags.set(row.id, !known.has(row.signature));
  }
  return flags;
}
