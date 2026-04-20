import { and, eq, sql } from "drizzle-orm";
import type { RouteMiddleware } from "rwsdk/router";
import { getDb } from "@/db";
import { account, memberships, user } from "@/db/schema";
import { fetchUserOrgLogins } from "@/lib/github-api";
import { getAuth } from "@/lib/better-auth";
import {
  getInstanceWhitelist,
  hasInstanceWhitelist,
} from "@/lib/instance-whitelist";
import { matchesWhitelist } from "@/lib/whitelist";

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
 * If an instance-level whitelist is configured, verify a fresh GitHub user
 * against it before they can land on any dashboard page. Users who already
 * belong to at least one team are trusted (grandfathered). Users that fail
 * the check have their `user` row deleted — the FK `ON DELETE cascade` on
 * `session`/`account`/`memberships`/`user_state` cleans up everything else —
 * and are redirected to `/signup?error=not_allowed` with their session
 * cookie cleared.
 *
 * Cheap on every page load for trusted users (one `COUNT(*)` on a tiny
 * indexed table). The GitHub round-trip only fires for users with zero
 * memberships, which is a narrow window between signup and first team join.
 */
export const enforceInstanceWhitelist: RouteMiddleware = async ({
  request,
  ctx,
}) => {
  if (!ctx.user) return;
  if (!hasInstanceWhitelist()) return;

  const db = getDb();
  const [{ count: membershipCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.userId, ctx.user.id));
  if (membershipCount > 0) return;

  const config = getInstanceWhitelist();
  const [githubAccount] = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(
      and(eq(account.userId, ctx.user.id), eq(account.providerId, "github")),
    )
    .limit(1);

  let allowed = false;
  if (githubAccount?.accessToken) {
    try {
      const orgs = await fetchUserOrgLogins(githubAccount.accessToken);
      allowed = matchesWhitelist({ email: ctx.user.email, orgs }, config);
    } catch {
      // Treat a failed GitHub lookup as fail-closed — no point leaving a
      // half-validated session alive.
      allowed = false;
    }
  }

  if (allowed) return;

  await db.delete(user).where(eq(user.id, ctx.user.id));
  ctx.user = undefined;
  ctx.session = undefined;

  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/signup?error=not_allowed`,
      // Clear Better Auth's session cookie. Name follows the library default
      // (`better-auth.session_token`). Max-Age=0 evicts it immediately.
      "Set-Cookie":
        "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    },
  });
};
