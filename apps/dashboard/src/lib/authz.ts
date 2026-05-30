import { db, and, eq, gt, sql } from "void/db";
import {
  memberships,
  projects,
  teamInvites,
  teams,
  type MembershipRole,
} from "@schema";
import {
  buildInviteMatchConds,
  getUserIdentity,
  inviteMatchedBy,
} from "@/lib/auth-users";

export type TeamRole = MembershipRole;

/** Returns the user's role within the team, or null if they're not a member. */
export async function getTeamRole(
  userId: string,
  teamId: string,
): Promise<TeamRole | null> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/**
 * Resolve a team by slug + verify membership in one round-trip. Returns null
 * when the team doesn't exist OR the user isn't a member — callers should
 * 404 in both cases (don't leak team existence).
 */
export async function resolveTeamBySlug(
  userId: string,
  teamSlug: string,
): Promise<{
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
} | null> {
  const rows = await db
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
  const row = rows[0];
  if (!row) return null;
  return row;
}

export async function getTeamProjects(
  teamId: string,
): Promise<{ slug: string; name: string }[]> {
  return db
    .select({ slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, teamId));
}

export async function getUserTeams(
  userId: string,
): Promise<{ slug: string; name: string }[]> {
  return db
    .select({ slug: teams.slug, name: teams.name })
    .from(teams)
    .innerJoin(memberships, eq(memberships.teamId, teams.id))
    .where(eq(memberships.userId, userId));
}

export interface PendingInvite {
  id: string;
  teamId: string;
  teamSlug: string;
  teamName: string;
  role: TeamRole;
  expiresAt: number;
  matchedBy: "email" | "githubLogin";
}

/**
 * Invites addressed directly to this user — by their `user.email` (from
 * void-managed auth tables) or by the GitHub login captured at OAuth sign-in
 * (`userGithubAccounts.githubLogin`). Used by the team picker to surface
 * "you've been invited" cards on first login.
 *
 * Resolves the user's `{ email, githubLogin }` identity through the
 * `auth-users` seam (which owns the raw `"user"` read + email lowercasing).
 */
export async function getPendingInvitesForUser(
  userId: string,
): Promise<PendingInvite[]> {
  const identity = await getUserIdentity(userId);
  const matchConds = buildInviteMatchConds(identity);
  if (!matchConds) return [];

  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: teamInvites.id,
      teamId: teamInvites.teamId,
      role: teamInvites.role,
      email: teamInvites.email,
      githubLogin: teamInvites.githubLogin,
      expiresAt: teamInvites.expiresAt,
      teamSlug: teams.slug,
      teamName: teams.name,
    })
    .from(teamInvites)
    .innerJoin(teams, eq(teams.id, teamInvites.teamId))
    .where(and(matchConds, gt(teamInvites.expiresAt, now)))
    .orderBy(sql`${teamInvites.createdAt} desc`);

  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    teamSlug: r.teamSlug,
    teamName: r.teamName,
    role: r.role,
    expiresAt: r.expiresAt,
    matchedBy: inviteMatchedBy(identity, r.email),
  }));
}

export async function requireTeamOwner(
  userId: string,
  teamSlug: string,
): Promise<{ id: string; slug: string; name: string }> {
  const team = await resolveTeamBySlug(userId, teamSlug);
  if (!team || team.role !== "owner") {
    throw new Error("forbidden");
  }
  return { id: team.id, slug: team.slug, name: team.name };
}

export interface ResolvedActiveTeam {
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
}

export interface ResolvedActiveProject {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
  teamName: string;
  role: TeamRole;
}

export interface TenantBundle {
  userTeams: { slug: string; name: string }[];
  activeTeam: ResolvedActiveTeam | null;
  teamProjects: { slug: string; name: string }[];
  activeProject: ResolvedActiveProject | null;
}

/**
 * Resolve every piece of team/project data the dashboard needs for a
 * `/t/:teamSlug[/p/:projectSlug]/...` request in a single SQL query.
 *
 * Same approach as the rwsdk version: one `memberships ⋈ teams ⟕ projects`
 * join filtered by `userId`, then derive each output bucket in JS from the
 * row set. `activeTeam` is null when the user isn't a member of `teamSlug`;
 * `activeProject` is null when the project doesn't exist within an authorized
 * team. Callers (middleware) should not 404 here — pages can render a
 * team/project picker for the no-active-team case.
 */
export async function resolveTenantBundleForUser(
  userId: string,
  teamSlug: string | null,
  projectSlug: string | null,
): Promise<TenantBundle> {
  const rows = await db
    .select({
      teamId: teams.id,
      teamSlug: teams.slug,
      teamName: teams.name,
      role: memberships.role,
      projectId: projects.id,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .leftJoin(projects, eq(projects.teamId, teams.id))
    .where(eq(memberships.userId, userId));

  const userTeamsBySlug = new Map<string, { slug: string; name: string }>();
  let activeTeam: ResolvedActiveTeam | null = null;
  let activeProject: ResolvedActiveProject | null = null;
  const teamProjectsBySlug = new Map<string, { slug: string; name: string }>();

  for (const r of rows) {
    if (!userTeamsBySlug.has(r.teamSlug)) {
      userTeamsBySlug.set(r.teamSlug, { slug: r.teamSlug, name: r.teamName });
    }
    if (teamSlug && r.teamSlug === teamSlug) {
      if (!activeTeam) {
        activeTeam = {
          id: r.teamId,
          slug: r.teamSlug,
          name: r.teamName,
          role: r.role,
        };
      }
      if (
        r.projectSlug &&
        r.projectName &&
        !teamProjectsBySlug.has(r.projectSlug)
      ) {
        teamProjectsBySlug.set(r.projectSlug, {
          slug: r.projectSlug,
          name: r.projectName,
        });
      }
      if (
        projectSlug &&
        r.projectSlug === projectSlug &&
        r.projectId &&
        r.projectName &&
        !activeProject
      ) {
        activeProject = {
          id: r.projectId,
          teamId: r.teamId,
          slug: r.projectSlug,
          name: r.projectName,
          teamSlug: r.teamSlug,
          teamName: r.teamName,
          role: r.role,
        };
      }
    }
  }

  return {
    userTeams: [...userTeamsBySlug.values()],
    activeTeam,
    teamProjects: [...teamProjectsBySlug.values()],
    activeProject,
  };
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
  const rows = await db
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
  const row = rows[0];
  if (!row) return null;
  return row;
}
