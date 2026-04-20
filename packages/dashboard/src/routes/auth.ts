import { env } from "cloudflare:workers";
import { getAuth } from "@/lib/better-auth";
import { parseBooleanEnv } from "@/lib/env-parse";
import { hasInstanceWhitelist } from "@/lib/instance-whitelist";

/**
 * Email verification is disabled (no mailer wired up yet) so leaving signup
 * open means anyone on the public internet can create an account. Self-hosters
 * who don't want that must set `ALLOW_OPEN_SIGNUP=1` explicitly; otherwise we
 * block Better Auth's email/password sign-up path at the edge.
 */
function isOpenSignupAllowed(): boolean {
  return parseBooleanEnv(env.ALLOW_OPEN_SIGNUP);
}

function isSignupRequest(url: URL): boolean {
  // Better Auth's email/password sign-up endpoint. Social (OAuth) callbacks
  // still need to hit /api/auth/* to complete sign-in for *existing* users,
  // so we do not block the whole prefix.
  return url.pathname.endsWith("/api/auth/sign-up/email");
}

/**
 * Better Auth catch-all handler — mounted at /api/auth/*. Handles every
 * sign-in / sign-out / callback / session route that Better Auth exposes.
 */
export async function authHandler({ request }: { request: Request }) {
  const url = new URL(request.url);
  if (isSignupRequest(url)) {
    if (!isOpenSignupAllowed()) {
      return new Response(
        JSON.stringify({
          error: "Signup is disabled on this Wrightful instance.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    // Email/password signups cannot satisfy the GitHub-org whitelist and
    // the domain whitelist relies on a verified email we don't yet have.
    if (hasInstanceWhitelist()) {
      return new Response(
        JSON.stringify({
          error: "Email signup is disabled — sign in with GitHub to continue.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const auth = getAuth();
  return auth.handler(request);
}
