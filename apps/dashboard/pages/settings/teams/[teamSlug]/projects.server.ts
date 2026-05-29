import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { db, desc, eq } from "void/db";
import { projects } from "@schema";
import { resolveTeamBySlug } from "@/lib/authz";

export type Props = InferProps<typeof loader>;

/**
 * Settings → Team → Projects. Lists the team's projects; navigation only —
 * the create-project action lives at `./projects/new`, key management on
 * `./p/[projectSlug]/keys`.
 */
export const loader = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  const team = await resolveTeamBySlug(user.id, teamSlug);
  if (!team) throw new Response("Not Found", { status: 404 });

  const projectRows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(desc(projects.createdAt));

  return {
    team,
    projects: projectRows,
  };
});
