import { defineHandler, type InferProps } from "void";
import { getSession } from "void/auth";
import { asc, db, eq } from "void/db";
import { projects } from "@schema";
import { resolveTeamBySlug } from "@/lib/authz";

export type Props = InferProps<typeof loader>;

/**
 * Team root. If the user lands here with at least one project, jump to the
 * first one — that's the natural "show me runs" landing. Otherwise render
 * the empty-state picker that points at /settings/.../projects/new.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) return c.redirect("/login");
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  const team = await resolveTeamBySlug(session.user.id, teamSlug);
  if (!team) throw new Response("Not Found", { status: 404 });

  const firstProject = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(asc(projects.id))
    .limit(1);

  if (firstProject[0]) {
    return c.redirect(`/t/${team.slug}/p/${firstProject[0].slug}`);
  }

  return { team };
});
