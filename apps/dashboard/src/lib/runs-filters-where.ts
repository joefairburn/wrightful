import { parseISO } from "date-fns";
import { and, eq, gte, inArray, like, lte, or } from "void/db";
import { runs } from "@schema";
import type { RunsFilters } from "@/lib/runs-filters";

type SqlFragment = NonNullable<ReturnType<typeof and>>;

/**
 * Escape the LIKE wildcard metacharacters (`\`, `%`, `_`) in a user-supplied
 * search term so they match literally inside the `%…%` pattern this module
 * builds — a typed `like()` call can't do this, so it's hand-written and
 * therefore unit-tested (`runs-filters-where.test.ts`). Each metacharacter is
 * doubled with a leading backslash; ordinary characters pass through unchanged.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Build a Drizzle `WHERE` clause from the filter-bar state. Caller passes the
 * already-scoped predicate (e.g. `and(eq(runs.teamId, scope.teamId),
 * eq(runs.projectId, scope.projectId))`) plus this function's output.
 *
 * Timestamps are stored as unix seconds; date-range filters convert the ISO
 * YYYY-MM-DD bounds to seconds at the UTC day boundary.
 */
export function buildRunsWhere(filters: RunsFilters): SqlFragment | undefined {
  const clauses: SqlFragment[] = [];

  if (filters.status.length > 0) {
    clauses.push(inArray(runs.status, filters.status));
  }
  if (filters.branch.length > 0) {
    clauses.push(inArray(runs.branch, filters.branch));
  }
  if (filters.actor.length > 0) {
    clauses.push(inArray(runs.actor, filters.actor));
  }
  if (filters.environment.length > 0) {
    clauses.push(inArray(runs.environment, filters.environment));
  }
  if (filters.from) {
    const fromSeconds = Math.floor(
      parseISO(`${filters.from}T00:00:00.000Z`).getTime() / 1000,
    );
    clauses.push(gte(runs.createdAt, fromSeconds));
  }
  if (filters.to) {
    const toSeconds = Math.floor(
      parseISO(`${filters.to}T23:59:59.999Z`).getTime() / 1000,
    );
    clauses.push(lte(runs.createdAt, toSeconds));
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const orClause = or(
      like(runs.commitMessage, pattern),
      like(runs.commitSha, pattern),
      like(runs.branch, pattern),
    );
    if (orClause) clauses.push(orClause);
  }

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

/**
 * Convenience helper that combines the tenant scope predicates with the
 * filter clauses so call sites don't have to. Returns a single Drizzle
 * SqlFragment fragment suitable for `.where(...)`.
 */
export function scopedRunsWhere(
  teamId: string,
  projectId: string,
  filters: RunsFilters,
): SqlFragment {
  const filterClause = buildRunsWhere(filters);
  return filterClause
    ? and(eq(runs.teamId, teamId), eq(runs.projectId, projectId), filterClause)!
    : and(eq(runs.teamId, teamId), eq(runs.projectId, projectId))!;
}
