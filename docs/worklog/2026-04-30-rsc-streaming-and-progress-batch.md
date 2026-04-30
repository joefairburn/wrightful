# 2026-04-30 — RSC Suspense streaming + batched RunProgress seeding

## What changed

Two related improvements to dashboard SSR latency:

1. **N+1 fix on progress seeding.** `RunsListPage` was calling `composeRunProgress(scope, runId)` per running row inside a `Promise.all`. Each call made two sequential DO queries (run row + testResults), and the `Promise.all` only parallelized at the JS layer — promises serialized against the same TenantDO. With N running runs that was `2N` sequential round-trips per page load, plus a redundant run-row fetch (the row was already in `allRuns`'s `selectAll()`).

2. **RSC Suspense streaming on the three heaviest data-bound pages** (`runs-list`, `flaky-tests`, `run-detail`). Each was a single async component that awaited every DO query before returning JSX, so users saw a blank screen until the slowest query finished (wall times of 600–960 ms with only 7–85 ms CPU on the runs list). Each page is now a synchronous shell + multiple `<Suspense>` regions that stream in independently.

Other tenant pages were assessed and skipped — `insights.tsx`, `suite-size.tsx`, `run-duration.tsx` are single-query or parallel-only renders where streaming wouldn't help; pickers, settings, and auth pages are not data-heavy. `slowest-tests.tsx` and `test-detail.tsx` are P2 candidates parked for follow-up.

## Progress batch (`progress.ts`)

New `composeRunProgressBatch(scope, runs)`:

- Takes pre-fetched run rows from the caller — no run-row DO call at all.
- Issues a single `WHERE runId IN (?, ?, ...)` against `testResults`.
- Groups rows by `runId` in JS and builds one `RunProgress` per input run.

Net effect: `2N` sequential hops → 1 hop, and zero redundant run-row reads.

The single-run `composeRunProgress` is unchanged in signature and behavior — `broadcastRunProgress` (the realtime ingest path) only has a `runId`, not a row, so it still needs the original entry point. Both share a private `buildRunProgress(run, rows)` helper so the snapshot shape is guaranteed identical between the two paths.

The branded `AuthorizedProjectId` discipline is preserved — the batch helper still receives a `TenantScope`, and the caller still owns the auth/scope checks via `getActiveProject()`.

## `RunsListPage`

Layout:

```
┌─────────────────────────────────────────────────────────────┐
│ Page header (title)            <Suspense> count badge       │  ← shell renders instant
├─────────────────────────────────────────────────────────────┤
│ <Suspense> filter bar (empty fallback → populated dropdowns)│  ← streams in
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ <Suspense> table area + footer pagination                   │  ← streams in
│   fallback: 8 skeleton rows + skeleton footer caption       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Implementation notes:

- **Shared totals promise.** `totalRuns` is needed in two regions (header badge + footer pagination). The page kicks off `countTotalRuns(project, filters)` once at the top and passes the same promise to both `<TotalRunsBadge>` (Suspense in the header) and `<RunsTableSection>` (Suspense around table+footer). Single query, two consumers.
- **Filter bar fallback is the real component.** During Suspense we render `<RunsFilterBar options={EMPTY_FILTER_OPTIONS} />` so the chip layout is identical before/after streaming — no layout shift, just dropdown options populating in place.
- **Table fallback preserves layout.** The fallback returns the same two siblings as the loaded section (table area `flex-1 overflow-y-auto` + footer `shrink-0`), so the parent flex layout doesn't shift when the real content swaps in.
- **Loaders are async server components co-located in the same file.** No new files. Each fetches its own data via the `TenantScope` from `getActiveProject()` (which works in nested RSCs because it reads request-scoped `requestInfo`).
- **`composeRunProgressBatch`** stays in `RunsTableSection` — running-run progress is part of the table view's data, not the shell.

## `FlakyTestsPage`

**Before:** three sequential awaits — aggregate query → branch list → sparklines+failures `Promise.all`. Range tabs, title, and table all rendered together at the end.

**After:**

- **Shell** (instant): outer flex layout + range tabs (pure URL links).
- **`<Suspense>` #1 — `<FlakyHeaderLeft>`**: title (`{N} Flaky Tests`), description (with `showing top X` suffix), branch filter dropdown. Awaits the aggregates promise (for the count) and the branches promise (for the dropdown).
- **`<Suspense>` #2 — `<FlakyTableSection>`**: table (or empty-state) + sparklines + recent failures. Awaits aggregates → builds `testIds` → awaits the per-testId queries.

Aggregates promise is shared between header and table — same trick as `runs-list.tsx`'s shared `totalRunsPromise`.

## `RunDetailPage`

**Before:** sequential awaits — `getActiveProject` → `run` → `Promise.all([progress, history, branchRows])` → `loadFailingArtifactActions`. Header chrome, history chart, summary card, build sidebar, and test results all rendered in one shot at the end.

**After:**

- **Shell**: page header (back link, `Run #shortId`, status badge, timestamps), Summary card top half (branch/env/PR/commit/actor badges + commit message), Build sidebar. All derived from the `run` row alone (kept blocking — single cheap query, required for the 404 check).
- **`<Suspense>` #1 — `<RunHistorySection>`**: `<RunHistoryChart>` + branch filter + stats slot. Awaits `historyPromise` and `branchesPromise`. Skeleton fallback at the same height to avoid layout shift.
- **`<Suspense>` #2 — `<RunProgressInSummary>`**: progress portion of the Summary card (`<RunSummaryIsland>` for live runs, `<RunProgressSummary>` otherwise). Awaits `progressPromise`. Skeleton fallback that matches the progress layout.
- **`<Suspense>` #3 — `<RunTestsSection>`**: per-test list (`<RunTestsIsland>` for live runs, `<RunProgressTests>` otherwise). Awaits progress + a derived `artifactActionsPromise`. Skeleton fallback of 6 row placeholders.

**Bonus optimization**: switched the existing `composeRunProgress(scope, runId)` call to `composeRunProgressBatch(scope, [run])`. Since we already have the `run` row in hand, this avoids the redundant run-row refetch that `composeRunProgress` does internally — one TenantDO hop instead of two for the progress query.

**Dead code removed**: dropped the `if (!progress) return <NotFoundPage />;` guard. With the run already verified to exist before kicking off the progress query, that branch was unreachable.

## Files changed

| File                                               | Change                                                                                                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/routes/api/progress.ts`    | Extract `buildRunProgress` private helper; refactor `composeRunProgress` to call it; add new exported `composeRunProgressBatch(scope, runs)` for SSR-with-rows paths.                               |
| `packages/dashboard/src/app/pages/runs-list.tsx`   | Split into shell + 3 async loaders (`TotalRunsBadge`, `FilterBarLoader`, `RunsTableSection`) with two `<Suspense>` regions. Replace `Promise.all`-over-`composeRunProgress` with one batch call.    |
| `packages/dashboard/src/app/pages/flaky-tests.tsx` | Split into shell + 2 async loaders (`FlakyHeaderLeft`, `FlakyTableSection`). Two `<Suspense>` boundaries with skeleton fallbacks. Shared aggregates promise.                                        |
| `packages/dashboard/src/app/pages/run-detail.tsx`  | Split into shell + 3 async loaders (`RunHistorySection`, `RunProgressInSummary`, `RunTestsSection`). Three `<Suspense>` boundaries. Switched to `composeRunProgressBatch`. Dropped dead null-check. |

No new files, no API contract changes, no schema changes, no migrations.

## Why this approach

- **Don't refetch what the page already has.** The runs-list page's main query is `selectAll()`, so the run rows are already in memory. Passing them through is free.
- **Keep `composeRunProgress` for the realtime path.** Ingest broadcasting never has a row in hand, only a `runId`. Rather than force two DO queries on it for symmetry, share the inner `buildRunProgress` and let each entry point fetch only what its caller doesn't already have.
- **`scope.batch()` doesn't apply here.** That helper is for atomic multi-statement writes inside `ctx.storage.transactionSync()`. The batch progress query is a single read — collapsing it via Kysely's `where(..., "in", ...)` is the right tool.

## Out of scope

- `slowest-tests.tsx`, `test-detail.tsx` — P2 streaming candidates with smaller wins; revisit after browser-validating the P1 changes.
- The four parallel `project.db.*` queries in the runs-list filter loader are still four separate TenantDO hops (Promise.all parallelizes JS, not the DO). A single batched read would collapse them to one hop.
- The auth/session path (`loadSession` → `requireUser` → `getActiveProject` → `tenantScopeForUser`) still hits ControlDO twice on every authenticated page. A unified `(sessionToken, teamSlug, projectSlug) → {user, project, role}` RPC would save a hop on every page.
- Caching the ControlDO membership lookup in `getActiveProject()` — every authenticated page still does at least one ControlDO round-trip; separate change with different risk profile (invalidation on membership change).
- Error boundaries around the new Suspense regions — currently errors propagate as before; revisit when there's a project-wide error UI strategy.

## Verification

| Check                                          | Result                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `pnpm format`                                  | Clean                                                      |
| `pnpm lint`                                    | 28 pre-existing warnings, 0 errors (none in changed files) |
| `pnpm --filter @wrightful/dashboard typecheck` | Clean                                                      |
| `pnpm --filter @wrightful/dashboard test`      | 157 / 157 passed                                           |
| `pnpm --filter @wrightful/reporter test`       | 81 / 81 passed                                             |

Manual checks to perform after deploy:

- **Runs list** — open `/t/:teamSlug/p/:projectSlug` with the network throttled. The page header (title + search input) and filter chips should appear before any data; the count badge should appear as a small skeleton box and resolve to the number; the table should show 8 skeleton rows that swap in to real rows. With at least one running run, the running row's `RunRowProgressIsland` should still receive its seeded `RunProgress` and the WS connection should hand off without flicker.
- **Flaky tests** — `/t/:teamSlug/p/:projectSlug/flaky` — range tabs (`7d` / `14d` / `30d`) appear immediately. Title + description + branch picker stream in. Table rows stream in next. Toggling a range or branch refetches both regions.
- **Run detail** — `/t/:teamSlug/p/:projectSlug/runs/:id` — header chrome (back link, run number, status badge, timestamps), Summary card badges, and the Build sidebar all appear immediately. History chart, progress display, and test results each stream in. Live run: the running-state islands receive their seeded `RunProgress` once Suspense resolves and the WS handoff still works.
- **Cloudflare observability** — wall time on `GET /t/:team/p/:project` should drop noticeably whenever there are 2+ running runs. CPU time should be unchanged.
- **Realtime ingest** — trigger a fresh run via `packages/e2e` and confirm progress still streams to the run-detail island; exercises the unchanged `broadcastRunProgress` path.
- With network throttled: layout should not shift when each region swaps in. If it does, the corresponding skeleton needs its dimensions tightened.
