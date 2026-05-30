import { and, db, isNotNull, sql } from "void/db";
import { runs } from "@schema";
import { runScopeWhere, type TenantScope } from "@/lib/scope";

/**
 * Distinct, sorted branch list of runs in a project. Used by the run-history
 * branch filter in tests / flaky-tests / slowest-tests / run-detail.
 *
 * Single SELECT DISTINCT against the `runs` table, gated on the scoped
 * `projectId` (and teamId for defense in depth). The composite index
 * `runs_project_branch_idx` lets SQLite skip-scan distinct values.
 */
export async function loadProjectBranches(
  scope: TenantScope,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ value: runs.branch })
    .from(runs)
    .where(and(runScopeWhere(scope), isNotNull(runs.branch)))
    .orderBy(sql`${runs.branch} asc`);
  return rows.map((r) => r.value).filter((v): v is string => !!v);
}
