import type { Context } from "hono";
import { requireAuth } from "void/auth";
import {
  requireTeamOwner,
  resolveProjectBySlugs,
  type TeamRole,
} from "@/lib/authz";

export interface OwnedTeam {
  id: string;
  slug: string;
  name: string;
}

export interface OwnedProject {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  role: TeamRole;
}

/**
 * Append (or overwrite) a query-string param on `base` and return a redirect
 * Response. Used by settings server actions to surface inline form errors
 * across the no-JS slow-path redirect.
 */
export function redirectWithParam(
  c: Context,
  base: string,
  key: string,
  value: string,
): Response {
  const url = new URL(base, "http://placeholder.local");
  url.searchParams.set(key, value);
  return c.redirect(`${url.pathname}${url.search}`);
}

/**
 * Resolve the team slug from the route, verify the signed-in user is its
 * owner, and build the redirect-back URL. 404s instead of 403ing so we
 * don't leak team existence to non-owners.
 */
export async function requireOwnerScope(
  c: Context,
  hereFor: (team: OwnedTeam) => string,
): Promise<{ team: OwnedTeam; here: string }> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  let team: OwnedTeam;
  try {
    team = await requireTeamOwner(user.id, teamSlug);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  return { team, here: hereFor(team) };
}

/**
 * Resolve the project from `teamSlug` + `projectSlug` route params and
 * require the user be the team's owner. Same 404-on-failure rule.
 */
export async function requireOwnedProjectScope(
  c: Context,
  hereFor: (project: OwnedProject) => string,
): Promise<{ project: OwnedProject; here: string }> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  if (!teamSlug || !projectSlug) {
    throw new Response("Not Found", { status: 404 });
  }
  const project = await resolveProjectBySlugs(user.id, teamSlug, projectSlug);
  if (!project || project.role !== "owner") {
    throw new Response("Not Found", { status: 404 });
  }
  return { project, here: hereFor(project) };
}
