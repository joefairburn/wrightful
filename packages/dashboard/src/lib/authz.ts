import { getDb } from "@/db";

export type TeamRole = "owner" | "member";

/** Returns the user's role within the team, or null if they're not a member. */
export async function getTeamRole(
  userId: string,
  teamId: string,
): Promise<TeamRole | null> {
  const db = getDb();
  const row = await db
    .selectFrom("memberships")
    .select("role")
    .where("userId", "=", userId)
    .where("teamId", "=", teamId)
    .limit(1)
    .executeTakeFirst();
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
  const row = await db
    .selectFrom("teams")
    .innerJoin("memberships", (join) =>
      join
        .onRef("memberships.teamId", "=", "teams.id")
        .on("memberships.userId", "=", userId),
    )
    .select([
      "teams.id as id",
      "teams.slug as slug",
      "teams.name as name",
      "memberships.role as role",
    ])
    .where("teams.slug", "=", teamSlug)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return { ...row, role: row.role as TeamRole };
}

export async function getTeamProjects(
  teamId: string,
): Promise<{ slug: string; name: string }[]> {
  const db = getDb();
  return db
    .selectFrom("projects")
    .select(["slug", "name"])
    .where("teamId", "=", teamId)
    .execute();
}

export async function getUserTeams(
  userId: string,
): Promise<{ slug: string; name: string }[]> {
  const db = getDb();
  return db
    .selectFrom("teams")
    .innerJoin("memberships", "memberships.teamId", "teams.id")
    .select(["teams.slug as slug", "teams.name as name"])
    .where("memberships.userId", "=", userId)
    .execute();
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
  const row = await db
    .selectFrom("projects")
    .innerJoin("teams", "teams.id", "projects.teamId")
    .innerJoin("memberships", (join) =>
      join
        .onRef("memberships.teamId", "=", "teams.id")
        .on("memberships.userId", "=", userId),
    )
    .select([
      "projects.id as id",
      "projects.teamId as teamId",
      "projects.slug as slug",
      "projects.name as name",
      "teams.slug as teamSlug",
      "memberships.role as role",
    ])
    .where("teams.slug", "=", teamSlug)
    .where("projects.slug", "=", projectSlug)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return { ...row, role: row.role as TeamRole };
}
