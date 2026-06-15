import type { Context } from "hono";
import { requireAuth } from "void/auth";
import {
  resolveProjectBySlugs,
  resolveTeamBySlug,
  type TeamRole,
} from "@/lib/authz";
import { can, type Capability } from "@/lib/roles";

/**
 * Status-agnostic failure raised by the owner-resolution core
 * ({@link resolveOwnedTeam} / {@link resolveOwnedProject}). It carries NO HTTP
 * status and NO redirect URL — every call site decides how to render it:
 * the page seams ({@link requireOwnerScope} / {@link requireOwnedProjectScope})
 * map it to a 404 Response (don't leak existence to non-owners) and build the
 * `here` redirect URL; the JSON API handlers map it to their chosen status.
 * Concentrating the slug-read + owner gate here means the page-vs-API status
 * difference is a single explicit line at each call site instead of two
 * independently hand-rolled gates.
 */
export class AuthzError extends Error {
  constructor(message = "not authorized") {
    super(message);
    this.name = "AuthzError";
  }
}

export interface OwnedTeam {
  id: string;
  slug: string;
  name: string;
}

/** A membership-checked team plus the user's role within it. */
export interface MemberTeam extends OwnedTeam {
  role: TeamRole;
}

/**
 * The single non-obvious bit of knowledge the settings-scope seams concentrate:
 * a missing-or-unauthorized team 404s rather than 403s, so we never leak team
 * existence to a non-member. Given the membership-checked team row from
 * `resolveTeamBySlug` (null when the user isn't a member or the team is
 * missing) and an optional REQUIRED CAPABILITY, decide pass-through vs 404.
 *
 * The gate is keyed on a {@link Capability} (via `can(role, …)`), not a raw
 * role string, so the owner-vs-member-vs-viewer ladder lives in one place
 * (`roles.ts`) — `gateTeamScope(team, "manageMembers")` reads as the intent
 * rather than re-deriving `role === "owner"` here. Omitting the capability is
 * the bare membership gate (any role of an actual member passes).
 *
 * Returns the team (carrying its `role`, which gated pages use to hide
 * privileged UI) on success, or `null` to signal "404" — the async seams
 * translate `null` into a `Response`. Kept pure so the leak-avoidance gate is
 * unit-testable independent of the DB resolve.
 */
export function gateTeamScope(
  team: MemberTeam | null,
  requiredCapability?: Capability,
): MemberTeam | null {
  if (!team) return null;
  if (requiredCapability && !can(team.role, requiredCapability)) return null;
  return team;
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
 * Project-owner sibling of {@link gateTeamScope}. Given the membership-checked
 * project row from `resolveProjectBySlugs` (null when the user isn't a member
 * or the project is missing) and a REQUIRED CAPABILITY, decide pass-through vs
 * deny: a missing project OR a member whose role doesn't grant the capability
 * is denied (returns `null`).
 *
 * Keyed on a {@link Capability} (via `can(role, …)`) exactly like
 * {@link gateTeamScope}, so the project-resource authorization ladder lives in
 * `roles.ts` instead of being re-derived as `role === "owner"` here. Defaults
 * to `"mintKeys"` — the project-resource capability the API-key page and
 * monitors enforce — which preserves the historical owner-only behaviour
 * (only `owner` holds `mintKeys`). Kept pure so the gate is unit-testable
 * independent of the DB resolve and of how each tier renders the failure
 * (404 page vs 403 JSON).
 */
export function gateOwnedProject(
  project: OwnedProject | null,
  requiredCapability: Capability = "mintKeys",
): OwnedProject | null {
  if (!project || !can(project.role, requiredCapability)) return null;
  return project;
}

/**
 * Status-agnostic owner-resolution core for a team: read `teamSlug` from the
 * route, require the signed-in user be the team's owner, and return the owned
 * team — or throw {@link AuthzError} on a missing slug / missing team /
 * non-owner. Carries no HTTP status, so the page seam can render 404 (no
 * existence leak) while the JSON API handler renders 403/404 of its choosing.
 */
export async function resolveOwnedTeam(c: Context): Promise<OwnedTeam> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new AuthzError();
  // "Owner" is defined by capability, not the literal role string: only the
  // owner role holds `deleteTeam`, so gating on it preserves the exact
  // owner-only semantics every existing caller relies on.
  const member = gateTeamScope(
    await resolveTeamBySlug(user.id, teamSlug),
    "deleteTeam",
  );
  if (!member) throw new AuthzError();
  return { id: member.id, slug: member.slug, name: member.name };
}

/**
 * Status-agnostic owner-resolution core for a project: read `teamSlug` +
 * `projectSlug` from the route, require the signed-in user's role grant
 * `requiredCapability` (default `"mintKeys"`), and return the owned project —
 * or throw {@link AuthzError}. Mirrors {@link resolveOwnedTeam}; the HTTP
 * status is the caller's decision.
 */
export async function resolveOwnedProject(
  c: Context,
  requiredCapability: Capability = "mintKeys",
): Promise<OwnedProject> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  if (!teamSlug || !projectSlug) throw new AuthzError();
  const project = gateOwnedProject(
    await resolveProjectBySlugs(user.id, teamSlug, projectSlug),
    requiredCapability,
  );
  if (!project) throw new AuthzError();
  return project;
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
  let team: OwnedTeam;
  try {
    team = await resolveOwnedTeam(c);
  } catch (err) {
    if (err instanceof AuthzError)
      throw new Response("Not Found", { status: 404 });
    throw err;
  }
  return { team, here: hereFor(team) };
}

/**
 * Member-role sibling of {@link requireOwnerScope}: resolve the team slug from
 * the route and require only that the signed-in user is a *member* (any role).
 * Same deliberate 404-not-403 rule on a missing team or non-membership.
 *
 * `hereFor` is optional — loaders that only read can omit it (and ignore the
 * returned `here`), while actions pass it to build the redirect-back URL,
 * mirroring how `requireOwnedProjectScope` is reused from both contexts. The
 * returned team carries its `role` so member-gated pages can hide owner-only UI.
 */
export async function requireMemberScope(
  c: Context,
  hereFor?: (team: MemberTeam) => string,
): Promise<{ team: MemberTeam; here: string | undefined }> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  const team = gateTeamScope(await resolveTeamBySlug(user.id, teamSlug));
  if (!team) throw new Response("Not Found", { status: 404 });
  return { team, here: hereFor?.(team) };
}

/**
 * The general, capability-keyed team gate (roadmap 3.1) — the seam every
 * settings page/action should use to express WHAT it needs rather than WHICH
 * role. Resolves the team slug, requires the signed-in user be a member whose
 * role grants `action` (via `can(role, action)` in `gateTeamScope`), and
 * 404s — not 403s — on a missing team, a non-membership, OR an insufficient
 * role. Same leak-safe rule as {@link requireOwnerScope}.
 *
 * Examples:
 *   - settings-page loaders gate on `"viewSettings"` (member + owner pass; a
 *     viewer 404s, so a viewer reads the dashboard but never the settings
 *     surface);
 *   - member-management actions gate on `"manageMembers"` (owner-only today).
 *
 * `hereFor` is optional, mirroring {@link requireMemberScope}: read-only
 * loaders omit it; actions pass it to build the redirect-back URL.
 * {@link requireOwnerScope} is left intact for its existing callers — it is the
 * `deleteTeam`-capability special case with the narrower {@link OwnedTeam}
 * return shape.
 */
export async function requireRoleScope(
  c: Context,
  action: Capability,
  hereFor?: (team: MemberTeam) => string,
): Promise<{ team: MemberTeam; here: string | undefined }> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  const team = gateTeamScope(
    await resolveTeamBySlug(user.id, teamSlug),
    action,
  );
  if (!team) throw new Response("Not Found", { status: 404 });
  return { team, here: hereFor?.(team) };
}

/**
 * Resolve the project from `teamSlug` + `projectSlug` route params and require
 * the user's role grant `requiredCapability` (default `"mintKeys"` — the
 * key-management bar). Pass `"writeConfig"` for project-config mutations.
 * Same 404-on-failure rule.
 */
export async function requireOwnedProjectScope(
  c: Context,
  hereFor: (project: OwnedProject) => string,
  requiredCapability: Capability = "mintKeys",
): Promise<{ project: OwnedProject; here: string }> {
  let project: OwnedProject;
  try {
    project = await resolveOwnedProject(c, requiredCapability);
  } catch (err) {
    if (err instanceof AuthzError)
      throw new Response("Not Found", { status: 404 });
    throw err;
  }
  return { project, here: hereFor(project) };
}
