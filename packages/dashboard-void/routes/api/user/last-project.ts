import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { z } from "zod";
import { resolveProjectBySlugs } from "@/lib/authz";
import { setLastProject } from "@/lib/user-state";

const BodySchema = z.object({
  teamSlug: z.string().min(1),
  projectSlug: z.string().min(1),
});

/**
 * POST /api/user/last-project — persist the user's last-viewed project.
 * Accepts slugs (the client only has slugs) and resolves to the project id
 * server-side so `userState.lastProjectId` keeps referencing `projects.id`.
 *
 * Kept as a `routes/` endpoint rather than a page action: same rationale as
 * /api/user/last-team — the switcher fires fire-and-forget right before
 * `navigate(...)`, and we want raw `fetch()` semantics with no Inertia page
 * update on the source view.
 */
export const POST = defineHandler.withValidator({
  body: BodySchema,
})(async (c, { body }) => {
  const user = requireAuth(c);
  const project = await resolveProjectBySlugs(
    user.id,
    body.teamSlug,
    body.projectSlug,
  );
  if (!project) return c.json({ error: "Not found" }, 404);
  await setLastProject(user.id, project.id);
  return { ok: true };
});
