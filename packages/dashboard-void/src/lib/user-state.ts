import { and, asc, db, eq } from "void/db";
import { memberships, projects, teams, userState } from "@schema";

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
  const state = await getUserState(userId);
  const storedTeamId = state?.lastTeamId ?? null;
  const storedProjectId = state?.lastProjectId ?? null;

  if (storedTeamId) {
    const teamRows = await db
      .select({ teamSlug: teams.slug })
      .from(teams)
      .innerJoin(
        memberships,
        and(eq(memberships.teamId, teams.id), eq(memberships.userId, userId)),
      )
      .where(eq(teams.id, storedTeamId))
      .limit(1);

    if (teamRows[0]) {
      if (storedProjectId) {
        const projectRows = await db
          .select({ projectSlug: projects.slug })
          .from(projects)
          .where(
            and(
              eq(projects.id, storedProjectId),
              eq(projects.teamId, storedTeamId),
            ),
          )
          .limit(1);
        if (projectRows[0]) {
          return {
            kind: "project",
            teamSlug: teamRows[0].teamSlug,
            projectSlug: projectRows[0].projectSlug,
          };
        }
      }

      const firstProject = await db
        .select({ projectSlug: projects.slug })
        .from(projects)
        .where(eq(projects.teamId, storedTeamId))
        .orderBy(asc(projects.id))
        .limit(1);
      if (firstProject[0]) {
        return {
          kind: "project",
          teamSlug: teamRows[0].teamSlug,
          projectSlug: firstProject[0].projectSlug,
        };
      }
      return { kind: "team", teamSlug: teamRows[0].teamSlug };
    }
  }

  // No stored team (or user lost access) — pick the user's first team.
  const firstTeam = await db
    .select({ teamId: teams.id, teamSlug: teams.slug })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(teams.id))
    .limit(1);

  if (!firstTeam[0]) return null;

  const firstProject = await db
    .select({ projectSlug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, firstTeam[0].teamId))
    .orderBy(asc(projects.id))
    .limit(1);

  if (firstProject[0]) {
    return {
      kind: "project",
      teamSlug: firstTeam[0].teamSlug,
      projectSlug: firstProject[0].projectSlug,
    };
  }
  return { kind: "team", teamSlug: firstTeam[0].teamSlug };
}

/**
 * Persist the user's most recently viewed team / project. Used after login to
 * redirect users back to where they last were instead of dumping them on the
 * team picker.
 *
 * Upsert on `userId` so a user landing on the same project twice doesn't
 * accumulate stale rows.
 */
export async function setLastTeam(
  userId: string,
  teamId: string | null,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(userState)
    .values({ userId, lastTeamId: teamId, updatedAt: now })
    .onConflictDoUpdate({
      target: userState.userId,
      set: { lastTeamId: teamId, updatedAt: now },
    });
}

export async function setLastProject(
  userId: string,
  projectId: string | null,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(userState)
    .values({ userId, lastProjectId: projectId, updatedAt: now })
    .onConflictDoUpdate({
      target: userState.userId,
      set: { lastProjectId: projectId, updatedAt: now },
    });
}

/**
 * Smart "back to app" target for the settings shell: deep-link to the user's
 * most recently viewed project when it still resolves, then fall back to the
 * last team, then to `/`. Used by `pages/settings/layout.tsx` via shared
 * context — see `middleware/01.context.ts`.
 */
export async function resolveBackToAppHref(userId: string): Promise<string> {
  const state = await getUserState(userId);
  if (state?.lastProjectId) {
    const rows = await db
      .select({
        projectSlug: projects.slug,
        teamSlug: teams.slug,
      })
      .from(projects)
      .innerJoin(teams, eq(teams.id, projects.teamId))
      .where(eq(projects.id, state.lastProjectId))
      .limit(1);
    const row = rows[0];
    if (row) {
      return `/t/${row.teamSlug}/p/${row.projectSlug}`;
    }
  }
  if (state?.lastTeamId) {
    const rows = await db
      .select({ slug: teams.slug })
      .from(teams)
      .where(eq(teams.id, state.lastTeamId))
      .limit(1);
    if (rows[0]) return `/t/${rows[0].slug}`;
  }
  return "/";
}

export async function getUserState(userId: string) {
  const rows = await db
    .select()
    .from(userState)
    .where(eq(userState.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}
