import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { memberships, projects, teams, userState } from "@/db/schema";

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
  const db = getDb();

  // Stored state — only trust values the user still has access to.
  const [stored] = await db
    .select({
      teamId: userState.lastTeamId,
      projectId: userState.lastProjectId,
    })
    .from(userState)
    .where(eq(userState.userId, userId))
    .limit(1);

  const storedTeamId = stored?.teamId ?? null;
  const storedProjectId = stored?.projectId ?? null;

  if (storedTeamId) {
    const [row] = await db
      .select({ teamSlug: teams.slug })
      .from(teams)
      .innerJoin(
        memberships,
        and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
      )
      .where(eq(teams.id, storedTeamId))
      .limit(1);

    if (row) {
      if (storedProjectId) {
        const [projectRow] = await db
          .select({ projectSlug: projects.slug })
          .from(projects)
          .where(
            and(
              eq(projects.id, storedProjectId),
              eq(projects.teamId, storedTeamId),
            ),
          )
          .limit(1);
        if (projectRow) {
          return {
            kind: "project",
            teamSlug: row.teamSlug,
            projectSlug: projectRow.projectSlug,
          };
        }
      }

      const [firstProject] = await db
        .select({ projectSlug: projects.slug })
        .from(projects)
        .where(eq(projects.teamId, storedTeamId))
        .orderBy(asc(projects.id))
        .limit(1);
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
  const [firstTeam] = await db
    .select({ teamId: teams.id, teamSlug: teams.slug })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(teams.id))
    .limit(1);

  if (!firstTeam) return null;

  const [firstProject] = await db
    .select({ projectSlug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, firstTeam.teamId))
    .orderBy(asc(projects.id))
    .limit(1);

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
  const db = getDb();
  await db
    .insert(userState)
    .values({
      userId,
      lastTeamId: teamId,
      lastProjectId: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userState.userId,
      set: { lastTeamId: teamId, updatedAt: new Date() },
    });
}

export async function setLastProject(
  userId: string,
  teamId: string,
  projectId: string,
): Promise<void> {
  const db = getDb();
  await db
    .insert(userState)
    .values({
      userId,
      lastTeamId: teamId,
      lastProjectId: projectId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userState.userId,
      set: {
        lastTeamId: teamId,
        lastProjectId: projectId,
        updatedAt: new Date(),
      },
    });
}
