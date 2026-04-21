import { type Compilable, type Kysely } from "kysely";
import { type Database } from "rwsdk/db";
import { getDb } from "@/db";
import {
  batchTenant as _batchTenant,
  getTenantDb as _getTenantDb,
} from "./internal";
import { tenantMigrations } from "./migrations";
import { TenantDO } from "./tenant-do";

export { TenantDO };

/**
 * Tenant schema type, inferred directly from the migration DSL in
 * `./migrations.ts`. Adding or removing columns updates the inferred type
 * automatically — no hand-maintained interface file.
 */
export type TenantDatabase = Database<typeof tenantMigrations>;

// ---------- Authorization brands ----------
//
// Branded strings. A plain `string` can't satisfy `AuthorizedTeamId` /
// `AuthorizedProjectId` at the type level, so every code path that wants
// to touch tenant data is forced to go through the `tenantScopeFor*`
// helpers below — which run the real auth check before minting the brand.
//
// The brand is nominal only (no runtime tag). `as AuthorizedTeamId` casts
// are still legal TypeScript, but they're deliberate and code-reviewable.
// The goal is to make accidental misuse impossible, not to resist an
// adversarial author in your own codebase.
declare const __authTeam: unique symbol;
export type AuthorizedTeamId = string & { readonly [__authTeam]: true };

declare const __authProject: unique symbol;
export type AuthorizedProjectId = string & { readonly [__authProject]: true };

/**
 * A capability object representing authorised access to one team's tenant
 * DO, scoped to one project inside that team. Route handlers / pages
 * receive one of these from a `tenantScopeFor*` helper and do all their
 * tenant-side work through it:
 *
 *   const scope = await tenantScopeForUser(userId, teamSlug, projectSlug);
 *   if (!scope) return <NotFoundPage />;
 *   await scope.db.selectFrom("runs").where("projectId", "=", scope.projectId)…
 *   await scope.batch([…]);
 */
export interface TenantScope {
  readonly teamId: AuthorizedTeamId;
  readonly teamSlug: string;
  readonly projectId: AuthorizedProjectId;
  readonly projectSlug: string;
  /** Kysely handle to the team's tenant DO. */
  readonly db: Kysely<TenantDatabase>;
  /** Atomic multi-statement write via `TenantDO.batchExecute`. */
  batch(queries: readonly Compilable[]): Promise<void>;
}

// Internal factory. Only called from the two auth-checking helpers below
// and from `active-project.ts` (which re-runs the same checks for the
// session-based flow, then enriches the scope with display fields).
function buildScope(
  teamId: string,
  teamSlug: string,
  projectId: string,
  projectSlug: string,
): TenantScope {
  const brandedTeamId = teamId as AuthorizedTeamId;
  const brandedProjectId = projectId as AuthorizedProjectId;
  return {
    teamId: brandedTeamId,
    teamSlug,
    projectId: brandedProjectId,
    projectSlug,
    db: _getTenantDb(teamId),
    batch: (queries) => _batchTenant(teamId, queries),
  };
}

/**
 * Build a tenant scope for a signed-in user accessing
 * `/t/:teamSlug/p/:projectSlug/...`. Runs the membership check against the
 * control DB (`projects ⋈ teams ⋈ memberships WHERE userId = ?`) and
 * returns `null` when the user isn't a member of the owning team, or when
 * the project doesn't exist. Callers should render a 404 on `null`.
 */
export async function tenantScopeForUser(
  userId: string,
  teamSlug: string,
  projectSlug: string,
): Promise<
  | (TenantScope & {
      /** Control-DB project display name. */
      name: string;
      /** Control-DB team display name. */
      teamName: string;
    })
  | null
> {
  const row = await getDb()
    .selectFrom("projects")
    .innerJoin("teams", "teams.id", "projects.teamId")
    .innerJoin("memberships", (join) =>
      join
        .onRef("memberships.teamId", "=", "teams.id")
        .on("memberships.userId", "=", userId),
    )
    .select([
      "projects.id as projectId",
      "projects.name as projectName",
      "projects.slug as projectSlug",
      "teams.id as teamId",
      "teams.slug as teamSlug",
      "teams.name as teamName",
    ])
    .where("teams.slug", "=", teamSlug)
    .where("projects.slug", "=", projectSlug)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;

  const scope = buildScope(
    row.teamId,
    row.teamSlug,
    row.projectId,
    row.projectSlug,
  );
  return {
    ...scope,
    name: row.projectName,
    teamName: row.teamName,
  };
}

/**
 * Build a tenant scope for an ingest request authenticated by an API key.
 * The API-key row pins `projectId`; we resolve the owning team off it via
 * the control DB. Returns `null` if the project/team no longer exists
 * (e.g. the project was deleted between mint time and now).
 */
export async function tenantScopeForApiKey(
  apiKey: { projectId: string } | null | undefined,
): Promise<TenantScope | null> {
  if (!apiKey) return null;
  const row = await getDb()
    .selectFrom("projects")
    .innerJoin("teams", "teams.id", "projects.teamId")
    .select([
      "projects.id as projectId",
      "projects.slug as projectSlug",
      "teams.id as teamId",
      "teams.slug as teamSlug",
    ])
    .where("projects.id", "=", apiKey.projectId)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return buildScope(row.teamId, row.teamSlug, row.projectId, row.projectSlug);
}
