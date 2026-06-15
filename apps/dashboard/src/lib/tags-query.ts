import { db, eq, sql } from "void/db";
import { testTags } from "@schema";
import type { TenantScope } from "@/lib/scope";

/**
 * Distinct, sorted tag list for a project — feeds the test-catalog tag filter.
 *
 * `SELECT DISTINCT tag WHERE projectId = ?` runs as an index-only skip-scan on
 * `testTags_project_tag_idx` (`(projectId, tag)`). Project-scoped (not
 * window-scoped) so it lists every tag the project has ever used — cheap and
 * sufficient for a filter dropdown. Mirrors `loadProjectBranches`.
 *
 * Unlike the CI-history analytics joins, this does NOT exclude synthetic-monitor
 * tags (it skips the `runs` join entirely for the index-only scan); a stray
 * monitor tag in the filter list is harmless.
 */
export async function loadProjectTags(scope: TenantScope): Promise<string[]> {
  const rows = await db
    .selectDistinct({ value: testTags.tag })
    .from(testTags)
    .where(eq(testTags.projectId, scope.projectId))
    .orderBy(sql`${testTags.tag} asc`);
  return rows.map((r) => r.value);
}
