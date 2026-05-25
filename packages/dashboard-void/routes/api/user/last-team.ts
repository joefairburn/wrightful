import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { z } from "zod";
import { resolveTeamBySlug } from "@/lib/authz";
import { setLastTeam } from "@/lib/user-state";

const BodySchema = z.object({
  teamSlug: z.string().min(1),
});

/**
 * POST /api/user/last-team — persist the user's last-viewed team. Called by
 * the team switcher; the value drives post-login redirects on subsequent
 * visits. Accepts a slug (the client only has slugs) and resolves to the
 * id server-side so `userState.lastTeamId` keeps referencing `teams.id`.
 *
 * Kept as a `routes/` endpoint rather than a page action: the switcher fires
 * this fire-and-forget immediately before `navigate(...)`, so we want the
 * raw `fetch()` primitive (no Inertia page update) per the void docs'
 * "Choosing a Primitive" guidance. A page action would trigger an unwanted
 * page reload on the source view between click and navigation.
 */
export const POST = defineHandler.withValidator({
  body: BodySchema,
})(async (c, { body }) => {
  const user = requireAuth(c);
  const team = await resolveTeamBySlug(user.id, body.teamSlug);
  if (!team) return c.json({ error: "Not found" }, 404);
  await setLastTeam(user.id, team.id);
  return { ok: true };
});
