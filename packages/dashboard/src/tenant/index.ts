import {
  type Compilable,
  type DeleteQueryBuilder,
  type DeleteResult,
  type Kysely,
  type SelectQueryBuilder,
} from "kysely";
import { type Database } from "rwsdk/db";
import { getControlDb } from "@/control";
import {
  batchTenant as _batchTenant,
  getTenantDb as _getTenantDb,
} from "./internal";
import { tenantMigrations } from "./migrations";
import {
  type ScopedInsertBuilder,
  type ScopedTable,
  type ScopedUpdateBuilder,
  scopedDelete,
  scopedInsert,
  scopedSelect,
  scopedUpdate,
} from "./scoped-query";
import { TenantDO } from "./tenant-do";

export { TenantDO };
export type { ScopedTable };

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
 *   const runs = await scope.from("runs").selectAll().execute();
 *   await scope.batch([…]);
 *
 * The four query entry points (`from`, `insertInto`, `updateTable`,
 * `deleteFrom`) pre-apply `WHERE projectId = scope.projectId` on every
 * scoped table. Inserts and updates also strip `projectId` from their
 * value types so a caller can't write a row into the wrong project. The
 * raw Kysely handle is intentionally not on the public type — code
 * outside `src/tenant/**` has no way to bypass the predicate.
 */
export interface TenantScope {
  readonly teamId: AuthorizedTeamId;
  readonly teamSlug: string;
  readonly projectId: AuthorizedProjectId;
  readonly projectSlug: string;

  /** Pre-filtered SELECT entry. WHERE is pre-applied to the scope's project. */
  from<T extends ScopedTable>(
    table: T,
  ): SelectQueryBuilder<TenantDatabase, T, TenantDatabase[T]>;

  /** INSERT entry. `.values` types omit `projectId`; the scope injects it. */
  insertInto<T extends ScopedTable>(table: T): ScopedInsertBuilder<T>;

  /** UPDATE entry. `.set` omits `projectId`; the WHERE pre-applies the scope's project. */
  updateTable<T extends ScopedTable>(table: T): ScopedUpdateBuilder<T>;

  /** DELETE entry. WHERE is pre-applied to the scope's project. */
  deleteFrom<T extends ScopedTable>(
    table: T,
  ): DeleteQueryBuilder<TenantDatabase, T, DeleteResult>;

  /** Atomic multi-statement write via `TenantDO.batchExecute`. */
  batch(queries: readonly Compilable[]): Promise<void>;
}

/**
 * Build a `TenantScope` from already-authorised team/project ids.
 *
 * Only call this from a code path that has *just* verified the signed-in
 * user's membership of the owning team — the brand minted here is exactly
 * as trustworthy as that prior check. The `loadActiveProject` middleware
 * (`src/routes/middleware.ts`) is the canonical caller: it runs the
 * `memberships ⋈ teams ⋈ projects` lookup once per request and stashes the
 * result on `ctx`, then `getActiveProject()` reads `ctx.activeProject` and
 * mints the scope here without re-querying.
 */
export function tenantScopeFromIds(
  teamId: string,
  teamSlug: string,
  projectId: string,
  projectSlug: string,
): TenantScope {
  return buildScope(teamId, teamSlug, projectId, projectSlug);
}

// Internal factory. Only called from the two auth-checking helpers below
// and from `tenantScopeFromIds` (which is itself called by middleware that
// has just verified membership).
function buildScope(
  teamId: string,
  teamSlug: string,
  projectId: string,
  projectSlug: string,
): TenantScope {
  const brandedTeamId = teamId as AuthorizedTeamId;
  const brandedProjectId = projectId as AuthorizedProjectId;
  const db: Kysely<TenantDatabase> = _getTenantDb(teamId);
  const bindings = { db, projectId: brandedProjectId };
  return {
    teamId: brandedTeamId,
    teamSlug,
    projectId: brandedProjectId,
    projectSlug,
    from: (table) => scopedSelect(bindings, table),
    insertInto: (table) => scopedInsert(bindings, table),
    updateTable: (table) => scopedUpdate(bindings, table),
    deleteFrom: (table) => scopedDelete(bindings, table),
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
  const row = await getControlDb()
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
  const row = await getControlDb()
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
