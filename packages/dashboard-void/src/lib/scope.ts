import { db, eq } from "void/db";
import type { Context } from "hono";
import { projects, teams } from "@schema";
import { requireActiveProject } from "@/lib/active-project";
import type { ApiKey } from "@schema";

/**
 * Branded id types make it a compile-time error to feed a raw string
 * `projectId` into a scoped query without going through `tenantScope*`.
 * Preserves the same invariant the per-DO `TenantScope` enforced before:
 * every run-table query MUST carry an auth-checked project id.
 */
export type AuthorizedTeamId = string & { readonly __team: unique symbol };
export type AuthorizedProjectId = string & {
  readonly __project: unique symbol;
};

export interface TenantScope {
  readonly teamId: AuthorizedTeamId;
  readonly projectId: AuthorizedProjectId;
  readonly teamSlug: string;
  readonly projectSlug: string;
}

/**
 * Resolve the tenant scope for a session-authenticated dashboard request.
 * Reads `activeProject` from middleware context; throws 404 if absent (the
 * URL didn't carry a valid team/project pair, or the user isn't a member).
 */
export function tenantScopeForUser(c: Context): TenantScope {
  const ap = requireActiveProject(c);
  return {
    teamId: ap.teamId as AuthorizedTeamId,
    projectId: ap.id as AuthorizedProjectId,
    teamSlug: ap.teamSlug,
    projectSlug: ap.slug,
  };
}

/**
 * Resolve the tenant scope for a session-authenticated request that *isn't*
 * gated by `middleware/01.context.ts` (i.e. an API route under
 * `/api/t/...` where the middleware regex doesn't fire). Looks up the
 * project + verifies membership in one query.
 *
 * Returns null when the team doesn't exist, the project doesn't exist, or
 * the user isn't a member. Callers should map null to 404 — don't leak
 * existence.
 */
export async function tenantScopeForUserBySlugs(
  userId: string,
  teamSlug: string,
  projectSlug: string,
): Promise<TenantScope | null> {
  const { resolveProjectBySlugs } = await import("@/lib/authz");
  const project = await resolveProjectBySlugs(userId, teamSlug, projectSlug);
  if (!project) return null;
  return {
    teamId: project.teamId as AuthorizedTeamId,
    projectId: project.id as AuthorizedProjectId,
    teamSlug: project.teamSlug,
    projectSlug: project.slug,
  };
}

/**
 * Resolve the tenant scope for an API-key authenticated ingest request. The
 * key already binds the caller to exactly one project; one indexed join on
 * `projects` recovers the parent team plus the slugs the reporter needs for
 * its public-facing run URL. Throws 404 if the key's project was removed.
 */
export async function tenantScopeForApiKey(
  apiKey: Pick<ApiKey, "projectId">,
): Promise<TenantScope> {
  const rows = await db
    .select({
      teamId: projects.teamId,
      teamSlug: teams.slug,
      projectSlug: projects.slug,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, apiKey.projectId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Response("Project not found", { status: 404 });
  }
  return {
    teamId: row.teamId as AuthorizedTeamId,
    projectId: apiKey.projectId as AuthorizedProjectId,
    teamSlug: row.teamSlug,
    projectSlug: row.projectSlug,
  };
}
