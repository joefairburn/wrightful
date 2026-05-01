import type { RouteMiddleware } from "rwsdk/router";
import { getAuth } from "@/lib/better-auth";
import { resolveTenantBundleForUser } from "@/lib/authz";

// Matches `/t/:teamSlug` and optionally `/p/:projectSlug` after it. Anchored
// at the path root so settings routes (`/settings/teams/:teamSlug/...`) and
// invite-style routes don't trigger the bundle lookup.
const TENANT_PATH_RE = /^\/t\/([^/]+)(?:\/p\/([^/]+))?(?:\/|$)/;

/**
 * Load the Better Auth session (if any) onto ctx. Safe to call on any
 * request — leaves ctx.user unset when no session cookie is present.
 * Errors from getAuth() (e.g. missing BETTER_AUTH_SECRET) are intentionally
 * not swallowed so misconfiguration surfaces as a 500 instead of a redirect
 * loop through /login.
 */
export const loadSession: RouteMiddleware = async ({ request, ctx }) => {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    ctx.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    };
    ctx.session = {
      id: session.session.id,
      expiresAt: session.session.expiresAt,
    };
  }
};

/** Redirect to /login if no user is on the context. */
export const requireUser: RouteMiddleware = async (args) => {
  const { request, ctx } = args;
  if (!ctx.user) {
    await loadSession(args);
  }
  if (!ctx.user) {
    const url = new URL(request.url);
    const next = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?next=${next}`, 302);
  }
};

/**
 * Resolve team + project + sibling-projects + user's full team list in a
 * single ControlDO RPC and stash the result on `ctx`. No-op when the
 * request isn't under `/t/:teamSlug/...` or there's no signed-in user.
 *
 * Pages read `ctx.activeProject` via `getActiveProject()` (zero further DO
 * calls); the sidebar reads the rest from ctx. The duplicate
 * `tenantScopeForUser` lookup that used to run on every page handler is
 * gone — this middleware does the membership check for it.
 */
export const loadActiveProject: RouteMiddleware = async ({ request, ctx }) => {
  if (!ctx.user) return;
  const url = new URL(request.url);
  const match = url.pathname.match(TENANT_PATH_RE);
  if (!match) return;
  const [, teamSlug, projectSlug] = match;
  const bundle = await resolveTenantBundleForUser(
    ctx.user.id,
    teamSlug,
    projectSlug ?? null,
  );
  ctx.userTeams = bundle.userTeams;
  ctx.activeTeam = bundle.activeTeam;
  ctx.teamProjects = bundle.teamProjects;
  ctx.activeProject = bundle.activeProject;
};
