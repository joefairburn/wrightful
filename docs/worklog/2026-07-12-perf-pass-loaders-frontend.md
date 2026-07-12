# 2026-07-12 — Performance pass: SSR page loaders + React frontend

## What changed

Implemented every SSR-loader and frontend finding from the 2026-07-12
performance review (frontend + API endpoints; the DB-query layer had been
reviewed separately). Two themes:

1. **Loaders**: remove serial awaits of independent queries (each standalone
   Drizzle chain is a fresh `pg.Pool` connection to Hyperdrive under the void
   patch, so round-trip count dominates loader latency), stop re-querying data
   the tenant middleware already resolved, and stop shipping columns the page
   never renders.
2. **Frontend**: make the realtime consumer layer identity-stable so `React.memo`
   can actually bail. The ws plumbing (shared sockets, reducer bailouts) was
   already excellent, but there was no memoization anywhere and the reducers
   churned `summary`/group-array identities on every event, so a streaming run
   re-rendered the entire run-detail Tests tab and all 20 runs-list rows on
   every broadcast (multiple/sec).

API/ingest findings from the same review (reporter flush cadence, redundant
ingest query chains, `bumpTeamActivity`, serial broadcasts) are **not** part of
this pass.

## Loader changes

| Page                                                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Round trips                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `runs/[runId]/index.server.ts` (run detail)                                                  | run row + `loadProjectBranches` in one `better-all` wave; 404 gate right after the wave                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2 serial → 1 wave                                                       |
| `insights/run-duration.server.ts`                                                            | the two percentile CTEs (`perBucket` ∥ `overall`) run via `Promise.all` inside the deferred resolver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 2 serial → 1 wave                                                       |
| `runs/[runId]/diff.server.ts` + `src/lib/run-diff.ts`                                        | `resolveRunDiffTargets` restructured to two waves (head ∥ explicit-`?base` lookup; then auto-base ∥ candidates). New optional `opts.baseCandidateLimit` + `baseCandidates` on the result — the page's candidate query moved behind the same seam (new `loadBaseCandidates`), so base-selection branching still lives in one place. `resolveRunDiff` (JSON API) unchanged: never requests candidates, pays nothing                                                                                                                                                                                      | 3 serial → 2 waves                                                      |
| `settings/teams/[teamSlug]/p/[projectSlug]/keys.server.ts`                                   | keys list ∥ codeowners row in one `all()` wave                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2 serial → 1 wave                                                       |
| `settings/teams/[teamSlug]/general.server.ts`                                                | project count ∥ retention ∥ GitHub installations in one wave; count is now `count(*)` via `numericSql` (int8-as-string trap) instead of fetching every project id for `.length`                                                                                                                                                                                                                                                                                                                                                                                                                        | 3 serial → 1 wave, count returns 1 row not N                            |
| `t/[teamSlug]/index.server.ts` (team root)                                                   | team read from `c.get("shared")` (middleware keys the bundle on the URL team for `/t/*`); zero-project case short-circuits off `shared.teamProjects`. The `asc(projects.id)` first-project query stays when projects exist — the bundle's `WorkspaceListItem` has no `id`, so the deterministic "first created" pick can't be reproduced in memory                                                                                                                                                                                                                                                     | 2 → 1 (2 → 0 for empty teams)                                           |
| `pages/index.server.ts` (`/` picker)                                                         | `getUserTeams` replaced by `shared.userTeams` (identical `{slug, name}` set from the same bundle query)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | −1 per landing                                                          |
| `flaky.server.ts` + `flaky-test-row.tsx`                                                     | dropped `errorStack` from the recent-failures CTE/projection/types (never rendered anywhere — sweep confirmed only `recentFailures[0].errorMessage` + href fields are read) and cut `RECENT_FAILURES` 3 → 1                                                                                                                                                                                                                                                                                                                                                                                            | 150 rows × multi-KB stacks → 50 slim rows                               |
| Settings-wide: `middleware/01.context.ts` + `src/lib/authz.ts` + `src/lib/settings-scope.ts` | the bundle query (`resolveTenantBundleForUser`) has no team filter — it already fetched every membership+role and discarded all but the cookie team. Now retained as `TenantBundle.memberTeams` and set as a **server-only** context var (`c.set("memberTeams", …)`, same separation as `activeProject`; not on the client-visible `SharedBundle`). `requireRoleScope`/`resolveOwnedTeam` consult it via `resolveMemberTeam()` before falling back to `resolveTeamBySlug` — API routes (STUB shared) and unit tests hit the unchanged fallback. 404-vs-403, owner gating, and nav chrome are untouched | −1 membership query on every `/settings/teams/:slug/*` page (~10 pages) |

Test-detail payload (`tests/[testResultId]`): per-attempt `stdout`/`stderr` and
non-primary attempts' error text moved behind a single `defer()`
(`attemptDetails`), consumed via `use()` by both the non-primary attempt panels
(behind per-attempt Suspense, only mounted on tab click) and the artifacts
rail's Output section. The primary (default-tab) attempt's error stays eager —
it's the above-the-fold content. `loadTestResultChildren` was split into
composable helpers (`src/lib/test-result-children.ts`) so the MCP
`get_test_result` surface keeps its eager shape from the same projections.
Both page mutations (quarantine/owner) are separate API routes + redirect, so
the "no deferred props over a mutation response" rule is not in play. Worst
case eager payload drops from ~832 KiB to ~192 KiB. Details:
`2026-07-12-test-detail-defer-heavy-attempt-fields.md`.

## Frontend changes

- **`src/realtime/run-progress.ts`** — `applyRunProgressEvent` now reuses
  `prev.summary` when the event's summary is shallow-equal (exhaustive
  field-by-field compare, `Record<keyof RunProgressSummary, boolean>`-typed so
  a new wire field is a compile error until compared), and returns `prev`
  outright for empty-`changedTests` + equal-summary events — a full referential
  bail. New lean `RunSummaryState`/`applyRunSummaryEvent` reducer that ignores
  `changedTests` entirely (no `byId` clone).
- **`src/realtime/use-run-summary.ts`** (new) — summary-only counterpart of
  `useRunRoom` over the same `useFeedRoom` machinery (same reseed/reconnect
  semantics). The four summary-only leaves (`RunStatusGlyphLive`,
  `RunDurationLive`, `RunTestCountLive` in `run-detail-live.tsx`;
  `RunSummaryLive`) switched to it; only `RunProgress` still folds `byId`.
  Near the end of a 5k-test run this removes 4× full-map clones per event.
- **`src/components/run-progress.tsx`** — `liveByGroup` is now identity-stable:
  a cached snapshot (`LiveGroupCache`) is diffed per-id by object reference
  (the reducer guarantees unchanged rows keep identity), and only the touched
  groups' arrays are rebuilt; untouched groups keep their references.
  `groupBy` changes and emptied accumulators (ws-reconnect reseed) trigger a
  full rebuild (the reseed fast path avoids a quadratic removal walk).
  `onToggle` now passes the stable `useCallback`d `toggle` (taking `id`)
  instead of a fresh per-group closure.
- **`run-progress-group.tsx` / `run-progress-row.tsx`** — `TestGroup` and
  `TestRow` wrapped in `React.memo`; each file documents why every prop is
  identity-stable. Net effect: a progress event re-renders ~1 group + its
  changed rows instead of every open group (re-sort included) + every row.
- **`run-list-row.tsx`** — `RunListRow` memoized (feed reducer already
  preserves untouched-row identity; all props primitives or that row object):
  20 rows re-rendered per event → 1. Hover prefetch disabled on the row's
  stretched `RowLink` (`prefetch={false}`) — sweeping the runs table fired up
  to 20 full run-detail loaders (each resolving the deferred history chart),
  re-firing every 5 s.
- **`live-duration.tsx`** — per-row `setInterval` replaced by one shared
  module-level 1 s ticker consumed via `useSyncExternalStore`; pauses when the
  tab is hidden (snap-to-current on `visibilitychange`), interval torn down
  when the last running row unsubscribes. SSR/hydration determinism preserved
  (`getServerSnapshot` returns the old `null` sentinel; the `visibilitychange`
  listener attaches lazily on first client-side subscribe).

## Verification

- `pnpm check` — 0 errors. 139 warnings, all pre-existing (reporter
  `no-unsafe-type-assertion` family etc.); verified none are in files this
  pass touched. Formatting fixed on our files (plus a whitespace-only format
  of the pre-existing `2026-07-12-playwright-best-practices-pass.md`, which
  was blocking `vp check` from reaching lint/typecheck).
- `pnpm --filter @wrightful/dashboard test` — 315 passed | 4 skipped (workers
  suite) and 1313 passed (unit suite). Includes 8 new reducer cases covering
  the summary bail-outs and the new summary-only reducer
  (`run-progress-reducer.workers.test.ts`).
- Existing `run-diff` / `use-room-reseed` / `use-feed-room` / `live-duration`
  test files pass unchanged.
- Review pass over every diff: verified tenant scoping on all new/split
  queries (`childByTestResultWhere`, `runScopeWhere`), 404/redirect/ordering
  parity on the bundle-reuse loaders, prop-identity audits behind each
  `React.memo`, and behavior parity of the `resolveRunDiffTargets` two-wave
  restructure (head filter, self-compare, empty-branch gating all preserved).

## Not done / follow-ups

- API/ingest findings from the same review (reporter flush interval, ingest
  owner-probe/scope-query merge, `bumpTeamActivity` debounce, parallel
  broadcasts) — deliberately out of scope for this pass.
- Virtualizing very large expanded test groups — re-evaluate only if still
  needed after the memoization work.
- The MCP `get_test_result` path now issues 4 parallel child queries instead
  of 3 (composition keeps projections drift-free); negligible, noted for
  completeness.
