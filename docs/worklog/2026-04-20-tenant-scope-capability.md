# 2026-04-20 — Tenant DO auth: scope-capability API

Hardens tenant-DO access at the type system. Replaces the ad-hoc
`getTenantDb(teamId: string)` + `batchTenant(teamId: string, …)` public
surface with a capability-style `TenantScope` object that can only be
obtained through an auth-checking helper (`tenantScopeForUser` for
session flows, `tenantScopeForApiKey` for ingest).

## Why

Previously, any worker file could import `getTenantDb(teamId)` and start
issuing queries against any team's DO. The authorization checks
(`getActiveProject` for sessions, `resolveTenantScope(projectId)` for API
keys) were disciplined-but-not-enforced — a new handler could skip them.
DO isolation only separates teams, not bad callers inside the same
worker, so the correctness of tenant auth depended on reviewer vigilance.

## What the refactor guarantees

After this change, the _only_ ways to obtain a tenant-DB handle are:

1. `await tenantScopeForUser(userId, teamSlug, projectSlug)` — runs the
   `projects ⋈ teams ⋈ memberships` join, returns `null` when the user
   isn't a member.
2. `await tenantScopeForApiKey(apiKey)` — runs the
   `projects ⋈ teams WHERE projects.id = apiKey.projectId` join, returns
   `null` if the key's project was deleted.
3. `getActiveProject()` (the RSC-page helper) which wraps (1) and returns
   `ActiveProject = TenantScope & { name, teamName, id, slug }`.
4. `internalTenantStubForCron(teamId)` — the explicit, grep-able escape
   hatch. Only the cron watchdog uses it.

`teamId` and `projectId` are branded types (`AuthorizedTeamId`,
`AuthorizedProjectId`) nominal in TypeScript, so a plain `string` is
rejected at compile time by the internal factory. A direct import of the
raw helpers from `@/tenant/internal` is caught by oxlint
`no-restricted-imports` outside `src/tenant/**` and `src/scheduled.ts`.

## Shape

```ts
export interface TenantScope {
  readonly teamId: AuthorizedTeamId;
  readonly teamSlug: string;
  readonly projectId: AuthorizedProjectId;
  readonly projectSlug: string;
  readonly db: Kysely<TenantDatabase>;
  batch(queries: readonly Compilable[]): Promise<void>;
}
```

Page / handler pattern:

```ts
// Session-based (RSC page)
const project = await getActiveProject();
if (!project) return <NotFoundPage />;
const run = await project.db.selectFrom("runs")
  .where("projectId", "=", project.projectId)
  .where("committed", "=", 1)
  .executeTakeFirst();

// API-key-based (ingest)
const scope = await tenantScopeForApiKey(ctx.apiKey);
if (!scope) return jsonResponse({ error: "Unauthorized" }, 401);
await scope.batch([...]);
```

## Files touched

| File                                                                | Purpose                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tenant/internal.ts`                                            | New. `getTenantDb`, `batchTenant`, `internalTenantStubForCron`. Raw, auth-less. Importers whitelisted by oxlint.                            |
| `src/tenant/index.ts`                                               | Rewritten. Exports brand types, `TenantScope`, `tenantScopeForUser`, `tenantScopeForApiKey`, `TenantDO`, `TenantDatabase`. No raw helpers.  |
| `src/lib/active-project.ts`                                         | Simplified — delegates to `tenantScopeForUser`, adds display fields (`name`, `teamName`) + historical aliases (`id`, `slug`).               |
| `src/routes/api/runs.ts`                                            | `tenantScopeForApiKey`; removed `resolveTenantScope` local; all tenant queries go via `scope.db` / `scope.batch`.                           |
| `src/routes/api/artifacts.ts`                                       | Same.                                                                                                                                       |
| `src/routes/api/artifact-upload.ts`                                 | Same.                                                                                                                                       |
| `src/routes/api/run-test-preview.ts`                                | `tenantScopeForUser` (session-based).                                                                                                       |
| `src/routes/api/progress.ts`                                        | `composeRunProgress(scope, runId)` / `broadcastRunProgress(scope, runId)` — takes scope directly, no raw teamId.                            |
| `src/lib/test-artifact-actions.ts`                                  | `loadFailingArtifactActions(tenantDb, …)` — accepts a `scope.db` handle.                                                                    |
| `src/app/pages/{run-detail,runs-list,test-detail,test-history}.tsx` | Read `project.db` / pass `project` to `composeRunProgress`.                                                                                 |
| `src/scheduled.ts`                                                  | Uses `internalTenantStubForCron` (explicit escape hatch) + comment explaining the bypass.                                                   |
| `.oxlintrc.json`                                                    | `no-restricted-imports` for `@/tenant/internal` outside whitelisted paths.                                                                  |
| Tests                                                               | Unit tests now mock `tenantScopeFor*` instead of `getTenantDb`; added `makeTenantScope` helper for fabricating scopes over scripted Kysely. |

## Failure modes still open

- **Within-team cross-project leaks.** DO isolation separates teams, not
  projects. Queries inside a team's DO still need `WHERE projectId = ?`
  predicates. The brand on `scope.projectId` is a hint but doesn't enforce
  presence of the predicate in the Kysely query — that's still discipline
  (covered by `run-detail-scoping.test.ts` and integration tests).
- **Deliberate `as AuthorizedTeamId` casts.** The brand is nominal. An
  adversarial author could fabricate one. The goal is accident-prevention,
  not adversary-resistance.
- **Expired sessions / revoked keys.** Handled at the auth layer by Better
  Auth session expiry + `apiKeys.revokedAt` check — unchanged by this work.

## Verification

- `pnpm typecheck` — clean.
- `pnpm test` — 132/132 unit.
- `pnpm test:integration` — 8/8 integration (real DO + D1 + ingest flow).
- `pnpm test:all` — 140/140.
- `pnpm lint` — no new errors; the `no-restricted-imports` rule passes
  (no improper `@/tenant/internal` imports outside the whitelist).
- `pnpm format` — clean.
