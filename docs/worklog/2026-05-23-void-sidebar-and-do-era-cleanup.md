# 2026-05-23 — Sidebar `useShared()` wiring + DO-era cleanup

Two related cleanups in `packages/dashboard-void`, both surfaced while
diagnosing an empty tenant-page sidebar.

## 1. Sidebar nav was empty on `/t/:teamSlug/p/:projectSlug/...`

`AppSidebarContents` (`src/components/app-layout.tsx`) builds its nav
list from `activeTeam` + `activeProject`. Those came in via a
`useRequestInfo()` shim that read `useShared()`. In Void, `useShared()`
returns exclusively what middleware sets via `c.set("shared", {...})`
— but `middleware/01.context.ts` only set individual `c.var.*` keys
(`userTeams`, `activeTeam`, …) and never `shared`. So on tenant pages
`useShared()` returned `undefined`, `base` resolved to `null`, and
`navItems` was an empty array. Settings pages were unaffected because
each settings loader calls `setSettingsShared` which does set `shared`.

**Fix:** middleware now always seeds `c.set("shared", {...})` with the
auth user, plus the tenant bundle (`userTeams`, `activeTeam`,
`teamProjects`, `activeProject`) when the path matches
`/t/:teamSlug[/p/:projectSlug]/...`. Added a typed
`shared: SharedBundle` field on `CloudContextVariables`.

## 2. DO-era debt audit + cleanup

`packages/dashboard-void` was ported from the rwsdk dashboard, where
data was split between a singleton `ControlDO` (auth/tenancy) and
per-team `TenantDO` instances. Several patterns from that world were
copied across and no longer earn their keep under single-D1 logical
isolation. Most were already justified or cleaned up in
`2026-05-23-void-schema-first-principles.md`; this pass removes the
residual pieces.

### Removed

| Item                                                                           | File                       | Why it was debt                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopeWhere`, `scopeWhereChild` helpers                                        | `src/lib/scope.ts`         | Exported, never called — every caller hand-rolls the `and(eq(…), eq(…))`. They were meant to make project-scoping structural; the brand on `AuthorizedProjectId` already provides that guarantee at the type level.                                                                                                                                                                      |
| `c.set("userTeams" \| "activeTeam" \| "teamProjects", …)` in tenant middleware | `middleware/01.context.ts` | These existed for server-side sidebar reads in the rwsdk port. The sidebar now reads `useShared()`; only `c.var.activeProject` is read anywhere (`src/lib/active-project.ts`). The other three `c.var` slots + their `CloudContextVariables` augmentation entries were dead.                                                                                                             |
| `useRequestInfo()` / `src/lib/request-info.ts` shim                            | (deleted)                  | Explicitly labelled "Compatibility shim for the rwsdk `requestInfo` pattern". Wrapped `useShared()` in an unsafe `as SharedContext` cast and reshaped the return as `{ ctx: { … } }`. Split the source of truth between a local `SharedContext` interface and the middleware augmentation. `AppLayout` (the only consumer) now calls `useShared()` directly, typed via the augmentation. |

### Kept (already settled, recorded for context)

- `projectId` denormalised on every run-scoped child table — brand check enforces scope at the type level without runtime joins (`worklog 2026-05-23-void-schema-first-principles.md:51-57`).
- `teamId` denormalised on `runs` — defense-in-depth on the brand check + cheap live-socket authz in `src/live.ts` (same worklog, `:73-75`).
- Branded `AuthorizedProjectId` / `AuthorizedTeamId` / `TenantScope` in `src/lib/scope.ts` — type-level enforcement that scope checks ran before a query. Independent of the old DO boundary.
- D1 `db.batch([...])` for atomic multi-statement writes — correct D1 primitive; no `transactionSync` / `batchTenant` wrappers remain.

## Verification

```bash
cd packages/dashboard-void
pnpm exec tsgo --noEmit       # 0 errors
pnpm exec vp check --fix      # 0 errors, 75 warnings (pre-existing
                              # no-unsafe-type-assertion in auth.ts)
```

Manual: sidebar nav now renders on tenant pages; user menu still renders
on settings + tenant + signed-out pages (auth slot of `shared` is set
unconditionally by the middleware).
