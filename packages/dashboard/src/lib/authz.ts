import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships, projects, teams } from "@/db/schema";

export type TeamRole = "owner" | "member";

/** Returns the user's role within the team, or null if they're not a member. */
export async function getTeamRole(
  userId: string,
  teamId: string,
): Promise<TeamRole | null> {
  const db = getDb();
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
    .limit(1);
  return (row?.role as TeamRole | undefined) ?? null;
}

/**
 * Resolve a team by slug + verify membership in one round-trip.
 * Returns null when the team doesn't exist OR the user isn't a member —
 * callers should 404 in both cases (don't leak team existence).
 */
export async function resolveTeamBySlug(
  userId: string,
  teamSlug: string,
): Promise<{ id: string; slug: string; name: string; role: TeamRole } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: teams.id,
      slug: teams.slug,
      name: teams.name,
      role: memberships.role,
    })
    .from(teams)
    .innerJoin(
      memberships,
      and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
    )
    .where(eq(teams.slug, teamSlug))
    .limit(1);
  if (!row) return null;
  return { ...row, role: row.role as TeamRole };
}

export async function resolveProjectBySlugs(
  userId: string,
  teamSlug: string,
  projectSlug: string,
): Promise<{
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  role: TeamRole;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: projects.id,
      teamId: projects.teamId,
      slug: projects.slug,
      name: projects.name,
      teamSlug: teams.slug,
      role: memberships.role,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(
      memberships,
      and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
    )
    .where(and(eq(teams.slug, teamSlug), eq(projects.slug, projectSlug)))
    .limit(1);
  if (!row) return null;
  return { ...row, role: row.role as TeamRole };
}
