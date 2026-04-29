import { requestInfo } from "rwsdk/worker";
import { type TenantScope, tenantScopeForUser } from "@/tenant";

/**
 * The project scoping an RSC page render. Combines authorization (the
 * user is a member of the owning team) with the tenant-DO handle they
 * need for reads, plus the control-DB display fields used in the UI.
 *
 * Because `teamId` / `projectId` are branded and only mintable from
 * `tenantScopeFor*` helpers, any code that lands in an RSC page is
 * forced to go through the membership check before touching tenant
 * data. `scope.db` / `scope.batch` are the only way in.
 */
export type ActiveProject = TenantScope & {
  /** Alias of `projectSlug` — preserved for call-site legibility. */
  readonly slug: string;
  /** Display name of the project (from ControlDO `projects.name`). */
  readonly name: string;
  /** Display name of the team (from ControlDO `teams.name`). */
  readonly teamName: string;
  /**
   * Historical alias of `projectId`. Plain string (same underlying value)
   * so call sites that pass it straight into Kysely `where` clauses keep
   * working without a brand-narrowing cast.
   */
  readonly id: string;
};

/**
 * Resolve the project that scopes the current RSC page render from
 * `:teamSlug` / `:projectSlug` route params, gated on the signed-in
 * user's membership of the owning team.
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

  const scope = await tenantScopeForUser(userId, teamSlug, projectSlug);
  if (!scope) return null;

  return {
    ...scope,
    id: scope.projectId,
    slug: scope.projectSlug,
  };
}
