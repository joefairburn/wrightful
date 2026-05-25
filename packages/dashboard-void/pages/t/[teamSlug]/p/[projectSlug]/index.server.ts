import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, isNotNull, sql } from "void/db";
import { runs } from "@schema";
import { resolveTenantBundleForUser } from "@/lib/authz";
import {
  DEFAULT_PAGE_SIZE,
  hasAnyFilter,
  parseRunsFilters,
  type RunsFilters,
} from "@/lib/runs-filters";
import { scopedRunsWhere } from "@/lib/runs-filters-where";

export type Props = InferProps<typeof loader>;

/**
 * Runs list loader. Fetches a single page of runs plus the dropdown
 * options that feed the filter bar in one round-trip-batch. Returns the
 * filters state straight from the URL so the page component can re-use it
 * for pagination links + the filter-bar form.
 *
 * Active team + project context is sourced from the request middleware
 * (`middleware/01.context.ts`), so we still go through `resolveTenantBundleForUser`
 * to keep the loader self-contained — middleware populates `c.var`, this
 * runs the same path so a direct hit (no middleware?) still works.
 */
export const loader = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  if (!teamSlug || !projectSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  const bundle = await resolveTenantBundleForUser(
    user.id,
    teamSlug,
    projectSlug,
  );
  const project = bundle.activeProject;
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(c.req.url);
  const filters = parseRunsFilters(url.searchParams);
  const filtersActive = hasAnyFilter(filters);

  // Total rows + filter dropdown options + first page in parallel.
  const totalRunsPromise: Promise<number> = db
    .select({ value: sql<number>`count(*)` })
    .from(runs)
    .where(scopedRunsWhere(project.teamId, project.id, filters))
    .then((rows) => rows[0]?.value ?? 0);

  const [branchRows, actorRows, envRows, totalRuns] = await Promise.all([
    db
      .selectDistinct({ value: runs.branch })
      .from(runs)
      .where(
        and(
          eq(runs.teamId, project.teamId),
          eq(runs.projectId, project.id),
          isNotNull(runs.branch),
        ),
      ),
    db
      .selectDistinct({ value: runs.actor })
      .from(runs)
      .where(
        and(
          eq(runs.teamId, project.teamId),
          eq(runs.projectId, project.id),
          isNotNull(runs.actor),
        ),
      ),
    db
      .selectDistinct({ value: runs.environment })
      .from(runs)
      .where(
        and(
          eq(runs.teamId, project.teamId),
          eq(runs.projectId, project.id),
          isNotNull(runs.environment),
        ),
      ),
    totalRunsPromise,
  ]);

  const options = {
    branches: branchRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
    actors: actorRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
    environments: envRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
  };

  const totalPages = Math.max(1, Math.ceil(totalRuns / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(filters.page, totalPages);
  const offset = (currentPage - 1) * DEFAULT_PAGE_SIZE;

  const allRuns = await db
    .select()
    .from(runs)
    .where(scopedRunsWhere(project.teamId, project.id, filters))
    .orderBy(desc(runs.createdAt))
    .limit(DEFAULT_PAGE_SIZE)
    .offset(offset);

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      teamName: project.teamName,
      role: project.role,
    },
    runs: allRuns,
    totalRuns,
    currentPage,
    totalPages,
    pageSize: DEFAULT_PAGE_SIZE,
    offset,
    filters,
    filtersActive,
    options,
    pathname: url.pathname,
  };
});

// Re-export RunsFilters type for the page component.
export type { RunsFilters };
