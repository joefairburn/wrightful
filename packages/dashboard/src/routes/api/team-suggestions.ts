import { ulid } from "ulid";
import { getControlDb } from "@/control";
import { refreshUserOrgs } from "@/lib/github-orgs";
import type { AppContext } from "@/worker";

type HandlerArgs = {
  request: Request;
  ctx: AppContext;
  params: Record<string, string>;
};

/**
 * Accept a GitHub-org-gated team suggestion. The team's `githubOrgSlug` must
 * be in the user's live (freshly refreshed) list of GitHub orgs — we don't
 * trust the cache at the action boundary. Idempotent: if the user is already
 * a member we fall through to the redirect.
 */
export async function joinTeamHandler({ request, ctx, params }: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const teamSlug = params.teamSlug;
  const origin = new URL(request.url).origin;
  const db = getControlDb();

  const team = await db
    .selectFrom("teams")
    .select(["id", "slug", "githubOrgSlug"])
    .where("slug", "=", teamSlug)
    .limit(1)
    .executeTakeFirst();

  if (!team) return new Response("Not found", { status: 404 });

  // Already a member? Go to the team page.
  const existing = await db
    .selectFrom("memberships")
    .select("id")
    .where("userId", "=", ctx.user.id)
    .where("teamId", "=", team.id)
    .limit(1)
    .executeTakeFirst();
  if (existing) {
    return Response.redirect(`${origin}/t/${team.slug}`, 303);
  }

  if (!team.githubOrgSlug) {
    return new Response("Not found", { status: 404 });
  }

  // Authoritative check: re-fetch orgs from GitHub so a user who just left
  // the org can't ride a 30-minute cache.
  const refresh = await refreshUserOrgs(ctx.user.id);
  const target = team.githubOrgSlug.toLowerCase();
  if (!refresh.orgs.includes(target)) {
    return new Response("Forbidden", { status: 403 });
  }

  await db
    .insertInto("memberships")
    .values({
      id: ulid(),
      userId: ctx.user.id,
      teamId: team.id,
      role: "member",
      createdAt: Math.floor(Date.now() / 1000),
    })
    .onConflict((oc) => oc.columns(["userId", "teamId"]).doNothing())
    .execute();

  // Clear any prior dismissal so the team no longer surfaces as "available
  // to join" on the profile page after they've joined.
  await db
    .deleteFrom("teamSuggestionDismissals")
    .where("userId", "=", ctx.user.id)
    .where("teamId", "=", team.id)
    .execute();

  return Response.redirect(`${origin}/t/${team.slug}`, 303);
}

export async function dismissSuggestionHandler({
  request,
  ctx,
  params,
}: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });
  const teamId = params.teamId;
  if (!teamId) return new Response("Bad request", { status: 400 });

  const db = getControlDb();
  const now = Math.floor(Date.now() / 1000);
  await db
    .insertInto("teamSuggestionDismissals")
    .values({ userId: ctx.user.id, teamId, dismissedAt: now })
    .onConflict((oc) =>
      oc.columns(["userId", "teamId"]).doUpdateSet({ dismissedAt: now }),
    )
    .execute();

  return redirectOr204(request);
}

export async function undismissSuggestionHandler({
  request,
  ctx,
  params,
}: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });
  const teamId = params.teamId;
  if (!teamId) return new Response("Bad request", { status: 400 });

  const db = getControlDb();
  await db
    .deleteFrom("teamSuggestionDismissals")
    .where("userId", "=", ctx.user.id)
    .where("teamId", "=", teamId)
    .execute();

  return redirectOr204(request);
}

/**
 * fetch() callers don't set a Referer (by default) or accept navigational
 * redirects: 204 keeps them simple. Browser form POSTs do set a Referer;
 * redirect back so the page updates.
 */
function redirectOr204(request: Request): Response {
  const referer = request.headers.get("referer");
  if (!referer) return new Response(null, { status: 204 });
  try {
    const refUrl = new URL(referer);
    const reqUrl = new URL(request.url);
    if (refUrl.origin !== reqUrl.origin) {
      return new Response(null, { status: 204 });
    }
    return Response.redirect(referer, 303);
  } catch {
    return new Response(null, { status: 204 });
  }
}
