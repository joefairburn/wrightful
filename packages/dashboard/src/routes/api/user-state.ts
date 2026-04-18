import { z } from "zod";
import { resolveProjectBySlugs, resolveTeamBySlug } from "@/lib/authz";
import { setLastProject, setLastTeam } from "@/lib/user-state";
import type { AppContext } from "@/worker";

const lastTeamSchema = z.object({ teamSlug: z.string().min(1) });
const lastProjectSchema = z.object({
  teamSlug: z.string().min(1),
  projectSlug: z.string().min(1),
});

type HandlerArgs = {
  request: Request;
  ctx: AppContext;
};

export async function setLastTeamHandler({ request, ctx }: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const parsed = lastTeamSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return new Response("Invalid body", { status: 400 });
  }

  const team = await resolveTeamBySlug(ctx.user.id, parsed.data.teamSlug);
  if (!team) return new Response("Not found", { status: 404 });

  await setLastTeam(ctx.user.id, team.id);
  return new Response(null, { status: 204 });
}

export async function setLastProjectHandler({ request, ctx }: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const parsed = lastProjectSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return new Response("Invalid body", { status: 400 });
  }

  const project = await resolveProjectBySlugs(
    ctx.user.id,
    parsed.data.teamSlug,
    parsed.data.projectSlug,
  );
  if (!project) return new Response("Not found", { status: 404 });

  await setLastProject(ctx.user.id, project.teamId, project.id);
  return new Response(null, { status: 204 });
}
