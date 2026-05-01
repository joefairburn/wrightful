import { getControlDb } from "@/control";
import { getCachedUserOrgs } from "@/lib/github-orgs";

export type TeamRole = "owner" | "member";

/** Returns the user's role within the team, or null if they're not a member. */
export async function getTeamRole(
  userId: string,
  teamId: string,
): Promise<TeamRole | null> {
  const db = getControlDb();
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
): Promise<{
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
  githubOrgSlug: string | null;
} | null> {
  const db = getControlDb();
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
      "teams.githubOrgSlug as githubOrgSlug",
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
  const db = getControlDb();
  return db
    .selectFrom("projects")
    .select(["slug", "name"])
    .where("teamId", "=", teamId)
    .execute();
}

export async function getUserTeams(
  userId: string,
): Promise<{ slug: string; name: string }[]> {
  const db = getControlDb();
  return db
    .selectFrom("teams")
    .innerJoin("memberships", "memberships.teamId", "teams.id")
    .select(["teams.slug as slug", "teams.name as name"])
    .where("memberships.userId", "=", userId)
    .execute();
}

export interface SuggestedTeam {
  id: string;
  slug: string;
  name: string;
  githubOrgSlug: string;
  dismissed: boolean;
}

/**
 * Teams the user is NOT a member of, but whose `githubOrgSlug` matches one
 * of the user's cached GitHub orgs. Dismissed suggestions are still returned
 * with `dismissed: true` so the settings page can show them; the sidebar
 * filters them out.
 *
 * Callers must refresh the org cache where freshness matters (sign-in hook,
 * /settings/profile, /t/:teamSlug/join). This function reads the cache only.
 */
export async function getSuggestedTeamsForUser(
  userId: string,
): Promise<SuggestedTeam[]> {
  const cached = await getCachedUserOrgs(userId);
  if (!cached || cached.orgs.length === 0) return [];

  const db = getControlDb();
  const rows = await db
    .selectFrom("teams")
    .leftJoin("memberships", (join) =>
      join
        .onRef("memberships.teamId", "=", "teams.id")
        .on("memberships.userId", "=", userId),
    )
    .leftJoin("teamSuggestionDismissals", (join) =>
      join
        .onRef("teamSuggestionDismissals.teamId", "=", "teams.id")
        .on("teamSuggestionDismissals.userId", "=", userId),
    )
    .select([
      "teams.id as id",
      "teams.slug as slug",
      "teams.name as name",
      "teams.githubOrgSlug as githubOrgSlug",
      "teamSuggestionDismissals.dismissedAt as dismissedAt",
    ])
    .where("teams.githubOrgSlug", "in", cached.orgs)
    .where("memberships.id", "is", null)
    .orderBy("teams.createdAt", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    githubOrgSlug: r.githubOrgSlug ?? "",
    dismissed: r.dismissedAt != null,
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
  githubOrgSlug: string | null;
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
  /** All teams the user is a member of (slug + name only — sidebar list). */
  userTeams: { slug: string; name: string }[];
  /** The team matching `:teamSlug`, or null if the user isn't a member. */
  activeTeam: ResolvedActiveTeam | null;
  /** Sibling projects of the active team (empty when activeTeam is null). */
  teamProjects: { slug: string; name: string }[];
  /** The project matching `:projectSlug` within `:teamSlug`, or null. */
  activeProject: ResolvedActiveProject | null;
}

/**
 * Resolve every piece of team/project data the dashboard needs for a
 * `/t/:teamSlug[/p/:projectSlug]/...` request in a single ControlDO RPC.
 *
 * Replaces the four sequential lookups that `fetchAppSidebarData` used to
 * fan out (`getUserTeams` + `resolveTeamBySlug` + `getTeamProjects` +
 * `resolveProjectBySlugs`) plus the duplicate `tenantScopeForUser` lookup
 * the page handler used to make. The single underlying SQL is a
 * `memberships ⋈ teams ⟕ projects` join filtered by `userId`; we then
 * derive each output bucket in JS from the same row set.
 *
 * Returns a fully-populated bundle. `activeTeam` is null when the user
 * isn't a member of `teamSlug` (or it doesn't exist); `activeProject` is
 * null when the project doesn't exist within an authorised team. Callers
 * (middleware) should not 404 here — the page is allowed to render the
 * team/project picker for the no-active-team case.
 */
export async function resolveTenantBundleForUser(
  userId: string,
  teamSlug: string | null,
  projectSlug: string | null,
): Promise<TenantBundle> {
  const db = getControlDb();
  const rows = await db
    .selectFrom("memberships")
    .innerJoin("teams", "teams.id", "memberships.teamId")
    .leftJoin("projects", "projects.teamId", "teams.id")
    .select([
      "teams.id as teamId",
      "teams.slug as teamSlug",
      "teams.name as teamName",
      "teams.githubOrgSlug as githubOrgSlug",
      "memberships.role as role",
      "projects.id as projectId",
      "projects.slug as projectSlug",
      "projects.name as projectName",
    ])
    .where("memberships.userId", "=", userId)
    .execute();

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
          role: r.role as TeamRole,
          githubOrgSlug: r.githubOrgSlug,
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
          role: r.role as TeamRole,
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
  const db = getControlDb();
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
