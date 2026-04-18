import { requestInfo } from "rwsdk/worker";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships, projects, teams } from "@/db/schema";

export type ActiveProject = {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  teamName: string;
};

/**
 * Resolve the project that scopes the current RSC page render from
 * `:teamSlug` / `:projectSlug` route params, gated on the signed-in user's
 * membership of the owning team.
 *
 * Returns null when the user isn't authorised to view the project (caller
 * should render a 404 shell — we intentionally don't distinguish "no such
 * project" from "you can't see this project" to avoid leaking existence).
 */
export async function getActiveProject(): Promise<ActiveProject | null> {
  const params = requestInfo.params as Record<string, unknown>;
  const teamSlug = typeof params.teamSlug === "string" ? params.teamSlug : null;
  const projectSlug =
    typeof params.projectSlug === "string" ? params.projectSlug : null;
  if (!teamSlug || !projectSlug) return null;

  const ctx = requestInfo.ctx as { user?: { id: string } };
  const userId = ctx.user?.id;
  if (!userId) return null;

  const db = getDb();
  const [row] = await db
    .select({
      id: projects.id,
      teamId: projects.teamId,
      slug: projects.slug,
      name: projects.name,
      teamSlug: teams.slug,
      teamName: teams.name,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(
      memberships,
      and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
    )
    .where(and(eq(teams.slug, teamSlug), eq(projects.slug, projectSlug)))
    .limit(1);

  return row ?? null;
}
