# 2026-05-01 — Coalesce auth/tenant resolution into a single ControlDO RPC + enable Smart Placement

## What changed

Production telemetry on `bumper-wrightful` (Cloudflare Worker observability, last 24h) showed every authenticated RSC page sharing a ~470–500 ms wall-time baseline despite p50 CPU staying under 10 ms. The gap was subrequest wait — ~11 subrequests per request average — concentrated in a stack of redundant ControlDO lookups before the first content query could even start.

A trace of `GET /t/:teamSlug/p/:projectSlug` issued five sequential ControlDO calls before the page body:

| #   | Caller                                                       | What it asked for                                                |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | `loadSession` middleware                                     | session lookup (already cached in signed cookie since `810cc4f`) |
| 2   | sidebar `fetchAppSidebarData` → `resolveTeamBySlug`          | `teams ⋈ memberships`                                            |
| 3   | sidebar → `getTeamProjects` (sequential after #2)            | `projects WHERE teamId = ?`                                      |
| 4   | sidebar → `resolveProjectBySlugs` (parallel with #2 and #3?) | `projects ⋈ teams ⋈ memberships`                                 |
| 5   | page handler → `getActiveProject` → `tenantScopeForUser`     | **literal duplicate of #4**                                      |

This change replaces #2–#5 with a single `resolveTenantBundleForUser` query run from a new `loadActiveProject` middleware. The result is stashed on `ctx`; the sidebar and page handler both read from there. Net: one ControlDO RPC where there used to be four (call #1 is already cached cross-request by the cookie cache from `2026-04-30-better-auth-cookie-cache.md`).

Bundled with it: enabled Smart Placement (`"placement": { "mode": "smart" }`) so worker invocations are pinned to a colo close to the DOs they talk to. Single-line config; same redeploy.

## Code change

| File                                                          | Change                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/lib/authz.ts`                         | Added `resolveTenantBundleForUser(userId, teamSlug, projectSlug)`. One `memberships ⋈ teams ⟕ projects` SELECT scoped by `userId`; partitions rows in JS into `userTeams`, `activeTeam`, `teamProjects`, `activeProject`. New `ResolvedActiveTeam` / `ResolvedActiveProject` / `TenantBundle` types. |
| `packages/dashboard/src/routes/middleware.ts`                 | Added `loadActiveProject` middleware. Matches `^/t/:teamSlug(/p/:projectSlug)?` on the request URL; calls `resolveTenantBundleForUser` and writes `ctx.userTeams`, `ctx.activeTeam`, `ctx.teamProjects`, `ctx.activeProject`. No-op on non-`/t/` paths or when ctx.user is unset.                    |
| `packages/dashboard/src/tenant/index.ts`                      | Added `tenantScopeFromIds(teamId, teamSlug, projectId, projectSlug)` — public wrapper around the previously-private `buildScope`. Documented as "only callable after a fresh membership check," which `loadActiveProject` provides.                                                                  |
| `packages/dashboard/src/lib/active-project.ts`                | `getActiveProject()` now reads `ctx.activeProject` and mints the scope via `tenantScopeFromIds` — zero ControlDO calls. The function stays `async` for caller compatibility but no longer awaits anything.                                                                                           |
| `packages/dashboard/src/app/components/app-layout.tsx`        | `fetchAppSidebarData` now takes a pre-resolved `PreloadedTenant` from ctx instead of calling `getUserTeams` + `resolveTeamBySlug` + `getTeamProjects` + `resolveProjectBySlugs`. Only `getSuggestedTeamsForUser` (GitHub-org-driven) still fans out, and that's a separate cache.                    |
| `packages/dashboard/src/worker.tsx`                           | Wired `loadActiveProject` into the `render(Document, [...])` middleware chain right after `loadSession`. Extended `AppContext` with `userTeams` / `activeTeam` / `teamProjects` / `activeProject`.                                                                                                   |
| `packages/dashboard/wrangler.jsonc`                           | Added `"placement": { "mode": "smart" }`.                                                                                                                                                                                                                                                            |
| `packages/dashboard/src/__tests__/authz-bundle.test.ts` (new) | 10 unit tests pinning the SQL contract (one `SELECT ... WHERE userId = ?`) and the row → bucket partitioning across owner/member roles, missing project, missing team, teams-with-no-projects (LEFT JOIN nulls), null teamSlug, null projectSlug, cross-team isolation.                              |

## Behavior

| Event                                                 | What happens                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First request to `/t/:team/p/:project` (warm session) | `loadSession` (no DO call, cookie cache hit) → `loadActiveProject` runs **one** ControlDO RPC → `getActiveProject` reads ctx, no DO call.                         |
| First request to `/t/:team/p/:project` (cold session) | `loadSession` issues 1 DO call (refreshes cookie cache) → `loadActiveProject` runs 1 ControlDO RPC → page renders. Two DO calls instead of five.                  |
| User lacks membership                                 | `resolveTenantBundleForUser` returns `activeTeam: null`, `activeProject: null`. `getActiveProject` returns null; the page renders its 404 shell as before.        |
| Project doesn't exist within a team the user is in    | `activeTeam` populated, `activeProject: null`. Same 404 shell. Sibling projects still visible in the sidebar.                                                     |
| Membership revoked between requests                   | Next request re-runs `resolveTenantBundleForUser` — change is picked up immediately. (No long-lived caching of tenant data; only the request-scoped ctx.)         |
| `/t/:teamSlug` (project picker, no projectSlug)       | Middleware matches; populates `activeTeam`, `teamProjects`, `userTeams`, leaves `activeProject: null`.                                                            |
| `/`, `/login`, `/settings/*`                          | Middleware short-circuits (regex doesn't match). Settings sidebar still calls `getUserTeams` directly — unchanged.                                                |
| Smart Placement                                       | Cloudflare detects the DO bindings and pins worker invocations to a colo near the DOs after a few warm-up requests. Reduces cross-region RTT on every subrequest. |

## Tradeoff / risk

- **Brand integrity.** `tenantScopeFromIds` mints the `AuthorizedTeamId` / `AuthorizedProjectId` brands. The contract (documented at the export site and at the only caller, `getActiveProject`) is that the caller has just verified membership. The middleware does that on every request — there's no caching layer that would let a brand outlive its membership check.
- **Existing helpers unchanged.** `tenantScopeForUser` is still used by the WS room handler in `worker.tsx` (no ctx available there) and by three `/api/t/.../...` summary endpoints (which sit outside the `render(Document, [...])` block, so they don't get the middleware). Those handlers continue to do their own membership check; they're low-traffic and not on the user-perceived slow path.
- **Sidebar suspense fallback.** The sidebar still renders inside Suspense, but its async work is now just `getSuggestedTeamsForUser` (GitHub-org-cache lookup). On most page loads that resolves quickly; the Suspense boundary is preserved so a slow GitHub-orgs cache doesn't stall the page body.

## Verification

| Check                                                             | Result                                  |
| ----------------------------------------------------------------- | --------------------------------------- |
| `pnpm typecheck`                                                  | Clean                                   |
| `pnpm --filter @wrightful/dashboard test`                         | 167 / 167 passed (10 new, 157 existing) |
| `pnpm lint`                                                       | 30 pre-existing warnings, 0 errors      |
| `pnpm format`                                                     | Clean                                   |
| `pnpm --filter @wrightful/dashboard exec vitest run authz-bundle` | 10 / 10 passed                          |

Manual checks to perform after deploy:

- Hit `/t/<team>/p/<project>` while signed in. In Cloudflare Workers observability, confirm `$workers.cpuTimeMs` stays under ~50 ms but `$workers.wallTimeMs` baseline drops by ~250–400 ms vs. last week.
- Run the GraphQL Workers Analytics query for `workersInvocationsAdaptive.quantiles.wallTimeP50` filtered to `scriptName = bumper-wrightful` over a 1h window post-deploy and compare to a 1h window pre-deploy. Expect the p50 baseline to fall.
- Use Cloudflare MCP `workers/observability/telemetry/query` (events view, `wallTimeMs >= 1000`) to verify no new slow outliers appeared on `/t/...` pages.
- Smoke-test:
  - Logged out: `/t/<team>/p/<project>` redirects to `/login`.
  - Logged in to a team you're a member of: page renders normally.
  - Logged in to a team you're not a member of: 404 shell.
  - `/t/<team>` (no project): redirects to first project (or shows project picker if none).
  - `/settings/profile` and `/settings/teams/<slug>`: still work (middleware doesn't affect them).
- Smart Placement: after a few hours of warm traffic, check the placement column in the deployments view to confirm Cloudflare has selected a colo. The `cf.colo` field on observability events should converge.

## Out of scope

- **R2 presigned uploads.** `PUT /api/artifacts/:id/upload` is body-bound (p50 1.2 s, p95 2.9 s, CPU 3 ms) and would benefit from the worker stepping out of the upload path. Deferred — it requires provisioning R2 S3 access keys which adds a self-hosting deploy step we don't want to take on right now.
- The three `/api/t/.../...` summary endpoints (`run-summary`, `run-test-preview`, `test-result-summary`) still call `tenantScopeForUser` directly. They live outside the `render(Document, [...])` middleware chain; folding them in is a separate change. Low traffic in observability, not on the user-perceived slow path.
- The WS room handler in `worker.tsx:53` still calls `resolveProjectBySlugs` for handshake auth. Different lifecycle (no ctx); leaving as-is.
