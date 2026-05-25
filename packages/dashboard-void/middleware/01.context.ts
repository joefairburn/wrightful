import { defineMiddleware } from "void";
import { getSession } from "void/auth";
import {
  getUserTeams,
  resolveTenantBundleForUser,
  type ResolvedActiveProject,
  type ResolvedActiveTeam,
} from "@/lib/authz";
import { resolveBackToAppHref } from "@/lib/user-state";

/**
 * Resolves the per-request tenant bundle (active team + project + sibling
 * lists) once and publishes it as both `c.var.*` (for server-side loaders)
 * and `c.var.shared` (consumed by `useShared()` in the route-level layouts
 * `pages/settings/layout.tsx` and `pages/t/[teamSlug]/p/[projectSlug]/layout.tsx`).
 *
 * Always sets `shared` so the user-menu / sidebar can render on any route.
 * `shared` MUST be populated here (not in page loaders) — void's pages
 * protocol snapshots `c.get("shared")` before the loader runs, so any
 * `c.set("shared", …)` inside a loader is dropped.
 */
const TENANT_PATH_RE = /^\/t\/([^/]+)(?:\/p\/([^/]+))?(?:\/|$)/;
const SETTINGS_PATH_RE = /^\/settings(?:\/|$)/;

interface SharedBundle {
  auth: {
    user: {
      id: string;
      email: string;
      name: string;
      image: string | null;
    };
  } | null;
  userTeams: { slug: string; name: string }[];
  activeTeam: ResolvedActiveTeam | null;
  teamProjects: { slug: string; name: string }[];
  activeProject: ResolvedActiveProject | null;
  /**
   * Deep-link the settings "Back to app" rail uses to return to the user's
   * last-viewed project. Only resolved on /settings/* paths to avoid an
   * extra DB hit on every dashboard page.
   */
  backToAppHref: string;
}

declare module "void" {
  interface CloudContextVariables {
    /** Server-side handle to the active project; read via `getActiveProject(c)`. */
    activeProject?: ResolvedActiveProject | null;
    /** Read on the client via `useShared()`. */
    shared: SharedBundle;
  }
}

export default defineMiddleware(async (c, next) => {
  const session = getSession();
  const auth: SharedBundle["auth"] = session
    ? {
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image ?? null,
        },
      }
    : null;

  const url = new URL(c.req.url);
  const match = session ? url.pathname.match(TENANT_PATH_RE) : null;

  if (session && match) {
    const [, teamSlug, projectSlug] = match;
    const bundle = await resolveTenantBundleForUser(
      session.user.id,
      teamSlug,
      projectSlug ?? null,
    );
    c.set("activeProject", bundle.activeProject);
    c.set("shared", { auth, ...bundle, backToAppHref: "/" });
  } else if (session && SETTINGS_PATH_RE.test(url.pathname)) {
    const [userTeams, backToAppHref] = await Promise.all([
      getUserTeams(session.user.id),
      resolveBackToAppHref(session.user.id),
    ]);
    c.set("shared", {
      auth,
      userTeams,
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
      backToAppHref,
    });
  } else {
    c.set("shared", {
      auth,
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
      backToAppHref: "/",
    });
  }

  await next();
});
