import { getControlDb } from "@/control";

export type DefaultLanding =
  | { kind: "project"; teamSlug: string; projectSlug: string }
  | { kind: "team"; teamSlug: string };

/**
 * Resolve where the signed-in user should land when arriving at `/`.
 * Uses stored last-visited when still accessible, otherwise falls back
 * to the user's first team (by id order) and its first project.
 */
export async function resolveDefaultLanding(
  userId: string,
): Promise<DefaultLanding | null> {
  const db = getControlDb();

  // Stored state — only trust values the user still has access to.
  const stored = await db
    .selectFrom("userState")
    .select(["lastTeamId as teamId", "lastProjectId as projectId"])
    .where("userId", "=", userId)
    .limit(1)
    .executeTakeFirst();

  const storedTeamId = stored?.teamId ?? null;
  const storedProjectId = stored?.projectId ?? null;

  if (storedTeamId) {
    const row = await db
      .selectFrom("teams")
      .innerJoin("memberships", (join) =>
        join
          .onRef("memberships.teamId", "=", "teams.id")
          .on("memberships.userId", "=", userId),
      )
      .select("teams.slug as teamSlug")
      .where("teams.id", "=", storedTeamId)
      .limit(1)
      .executeTakeFirst();

    if (row) {
      if (storedProjectId) {
        const projectRow = await db
          .selectFrom("projects")
          .select("slug as projectSlug")
          .where("id", "=", storedProjectId)
          .where("teamId", "=", storedTeamId)
          .limit(1)
          .executeTakeFirst();
        if (projectRow) {
          return {
            kind: "project",
            teamSlug: row.teamSlug,
            projectSlug: projectRow.projectSlug,
          };
        }
      }

      const firstProject = await db
        .selectFrom("projects")
        .select("slug as projectSlug")
        .where("teamId", "=", storedTeamId)
        .orderBy("id", "asc")
        .limit(1)
        .executeTakeFirst();
      if (firstProject) {
        return {
          kind: "project",
          teamSlug: row.teamSlug,
          projectSlug: firstProject.projectSlug,
        };
      }
      return { kind: "team", teamSlug: row.teamSlug };
    }
  }

  // No stored team (or user lost access) — pick the user's first team.
  const firstTeam = await db
    .selectFrom("memberships")
    .innerJoin("teams", "teams.id", "memberships.teamId")
    .select(["teams.id as teamId", "teams.slug as teamSlug"])
    .where("memberships.userId", "=", userId)
    .orderBy("teams.id", "asc")
    .limit(1)
    .executeTakeFirst();

  if (!firstTeam) return null;

  const firstProject = await db
    .selectFrom("projects")
    .select("slug as projectSlug")
    .where("teamId", "=", firstTeam.teamId)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();

  if (firstProject) {
    return {
      kind: "project",
      teamSlug: firstTeam.teamSlug,
      projectSlug: firstProject.projectSlug,
    };
  }
  return { kind: "team", teamSlug: firstTeam.teamSlug };
}

export async function setLastTeam(
  userId: string,
  teamId: string,
): Promise<void> {
  const db = getControlDb();
  const now = Date.now();
  await db
    .insertInto("userState")
    .values({
      userId,
      lastTeamId: teamId,
      lastProjectId: null,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.column("userId").doUpdateSet({
        lastTeamId: teamId,
        updatedAt: now,
      }),
    )
    .execute();
}

export async function setLastProject(
  userId: string,
  teamId: string,
  projectId: string,
): Promise<void> {
  const db = getControlDb();
  const now = Date.now();
  await db
    .insertInto("userState")
    .values({
      userId,
      lastTeamId: teamId,
      lastProjectId: projectId,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.column("userId").doUpdateSet({
        lastTeamId: teamId,
        lastProjectId: projectId,
        updatedAt: now,
      }),
    )
    .execute();
}
