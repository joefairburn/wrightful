import { and, db, isNotNull, sql } from "void/db";
import { runs } from "@schema";
import { ciRunsScopeWhere, type TenantScope } from "@/lib/scope";

/**
 * Distinct, sorted branch list of runs in a project. Used by the run-history
 * branch filter in tests / flaky-tests / slowest-tests / run-detail.
 *
 * Single SELECT DISTINCT against the `runs` table, gated on the scoped
 * `projectId` (and teamId for defense in depth) plus the CI-analytics origin
 * exclusion (`ciRunsScopeWhere`): these options feed filters over CI history,
 * so monitor runs must not contribute branches. In practice synthetic runs
 * carry `branch = null` today — the exclusion is robustness against a future
 * monitor that stamps one. The `(projectId, branch)`
 * leading prefix of the composite index `runs_project_branch_created_at_idx`
 * (on `(projectId, branch, createdAt)`) covers the equality filter plus the
 * DISTINCT + ORDER BY branch ASC scan — SQLite skip-scans distinct values
 * (verified: `SEARCH runs USING INDEX runs_project_branch_created_at_idx`). If
 * this distinct-branch query proves hot enough to warrant a narrower dedicated
 * `(projectId, branch)` index, add one in a new numbered migration — measure
 * first; do not assume.
 */
export async function loadProjectBranches(
  scope: TenantScope,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ value: runs.branch })
    .from(runs)
    .where(and(ciRunsScopeWhere(scope), isNotNull(runs.branch)))
    .orderBy(sql`${runs.branch} asc`);
  return rows.map((r) => r.value).filter((v): v is string => !!v);
}
