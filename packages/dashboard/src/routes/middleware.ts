import type { RouteMiddleware } from "rwsdk/router";
import { getAuth } from "@/lib/better-auth";

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
