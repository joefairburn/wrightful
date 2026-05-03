import { z } from "zod";
import { resolveTenantBundleForUser } from "@/lib/authz";
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

  const bundle = await resolveTenantBundleForUser(
    ctx.user.id,
    parsed.data.teamSlug,
    null,
  );
  if (!bundle.activeTeam) return new Response("Not found", { status: 404 });

  await setLastTeam(ctx.user.id, bundle.activeTeam.id);
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

  const bundle = await resolveTenantBundleForUser(
    ctx.user.id,
    parsed.data.teamSlug,
    parsed.data.projectSlug,
  );
  if (!bundle.activeProject) return new Response("Not found", { status: 404 });

  await setLastProject(
    ctx.user.id,
    bundle.activeProject.teamId,
    bundle.activeProject.id,
  );
  return new Response(null, { status: 204 });
}
