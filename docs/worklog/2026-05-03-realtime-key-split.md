# 2026-05-03 — Realtime split: `summary` + `tests-tail` keys

## What changed

Follow-up to the same-day ingest-hot-path-perf work. That pass capped
the `RunProgress` broadcast at 1000 rows and made aggregates
incremental. This pass replaces the single `RunProgress` synced-state
key with two independent keys, one per consumer:

- **`summary`** (~150 B) — `RunSummary`: status, counts, totalDone,
  expectedTotal, totalTests, updatedAt.
- **`tests-tail`** (~10 KB max) — `RunTestsTail`: newest
  `TESTS_TAIL_SIZE = 50` testResults rows + updatedAt.

`SyncedStateServer` (`rwsdk/use-synced-state/worker`) scopes
subscribers per key, so the summary island only re-renders on counter
changes and the tests-list island only re-renders on test row
changes. Per-batch wire payload drops from ~150 KB → ~2 KB, and the
two islands no longer share re-render fate.

The cursor-paginated REST endpoint at
`/api/t/:teamSlug/p/:projectSlug/runs/:runId/results` (added in the
hot-path-perf pass as an overflow fallback) is now the **always-on**
source for the test-list initial state. The tests-list island
SSR-seeds with the first REST page and merges synced-state tail rows
on top by `RunProgressTest.id` (tail wins). The `truncated` field,
the `useExpandedTests` overflow hook, and the "synced wins on
overlap" merge logic all collapse into a single unified path.

## Details

| Item                                       | Before                                                    | After                                                                               |
| ------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Broadcast keys                             | One `"progress"` key with full `RunProgress`              | Two keys: `"summary"` (RunSummary) + `"tests-tail"` (RunTestsTail)                  |
| Per-batch broadcast payload                | ~150 KB (1000 capped rows + counters)                     | ~2 KB (~150 B summary + ~10 KB tail)                                                |
| `RunProgressSummary` re-renders on tail    | Yes (shared key)                                          | No (separate `"summary"` subscription)                                              |
| `RunTestsIsland` truncated branch          | `useExpandedTests` fetched all REST pages when truncated  | Always SSR-seeded from REST first page (200 rows); auto-paginates forward if needed |
| Tail window cap                            | `LIVE_TESTS_CAP = 1000`                                   | `TESTS_TAIL_SIZE = 50`                                                              |
| `composeRunProgressBatch` (runs-list path) | Read 1000 testResults rows × N runs (unused by that page) | `composeRunSummaryBatch` — pure transform, no DO hop                                |
| `RunProgress` interface                    | Combined type with `tests`, `truncated`                   | Removed; `RunSummary` + `RunTestsTail` replace it                                   |
| `LIVE_TESTS_CAP` constant                  | Exported from `progress.ts`                               | Removed                                                                             |

`composeRunSummary` reads only the `runs` row; `composeRunTestsTail`
reads only `testResults`. `broadcastRunUpdate` runs both in parallel
(`Promise.all`) so the broadcast is one round-trip per ingest batch.
The pure `buildRunSummary(run)` is exposed so SSR paths that already
hold the run row (`run-detail`, `runs-list`) can derive the summary
without an extra DO hop.

The runs-list page now uses `composeRunSummaryBatch` — a pure
transform over the run rows it already loaded. No more N-parallel
testResults queries (those rows weren't even rendered on that page).

### Why TESTS_TAIL_SIZE = 50

The tail is a "live edit window," not the rendered list. SSR loads up
to 200 newest rows from REST; the tail keeps the most recent ~50
fresh as the run progresses. 50 is enough to catch typical
mid-batch flips (status changes, retry counts) while keeping the
broadcast payload small and bounded. Easy to tune later — no contract
change.

### Why the tests-list island subscribes to two keys

The list header shows "X tests · Y files" using `summary.totalTests`
(the run-level authoritative count). To keep that count live as the
run grows past the SSR seed, the tests island also subscribes to
`"summary"`. The cost is one extra subscription per island; the
benefit is consistency between the summary tiles and the list header
during ingest.

### Why no `useExpandedTests` / `truncated` flag anymore

With REST as the always-on initial-load path, there's no "live payload
truncated, fall back to REST" decision to make. The flow is:

1. SSR fetches the first REST page (200 rows) → seed for the tests
   island.
2. Client island `usePaginatedTests` auto-paginates forward through
   subsequent REST pages until `nextCursor` is null. Same UX as the
   previous in-flight overflow path, just always-on instead of gated.
3. Synced-state tail (50 newest rows) merges on top by id; tail wins
   on collision so retries / status flips override the static REST
   snapshot.

For a run with ≤ 200 tests this is one REST call. For a run with
1,000 tests it's ~5 REST calls. Same as the prior truncated path for
large runs; one extra call for medium runs (200–1000) compared to the
prior cap-1000 broadcast — but the broadcast was paying that cost
every batch.

## Code fixes / migrations

| File                                                            | Change                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard/src/routes/api/progress.ts`                 | Replace `RunProgress`/`composeRunProgress*`/`broadcastRunProgress`/`LIVE_TESTS_CAP` with `RunSummary`/`RunTestsTail`/`composeRunSummary*`/`composeRunTestsTail`/`broadcastRunUpdate`/`TESTS_TAIL_SIZE`. Expose pure `buildRunSummary(run)`.            |
| `packages/dashboard/src/routes/api/run-results.ts`              | Extract `loadRunResultsPage(scope, runId, opts)` so SSR (run-detail) and the route handler share one query path. Handler becomes a thin HTTP wrapper.                                                                                                  |
| `packages/dashboard/src/routes/api/runs.ts`                     | `openRun`/`appendResults`/`completeRun` handlers now `await` `broadcastRunUpdate` (was fire-and-forget `broadcastRunProgress(...).catch(() => {})` in the prior pass — see below).                                                                     |
| `packages/dashboard/src/app/components/run-progress.tsx`        | Split `RunSummaryIsland` (subscribes to `"summary"`) and `RunTestsIsland` (subscribes to `"tests-tail"` + `"summary"`). New `usePaginatedTests` + `mergeTailOverPaged`. `RunRowProgressIsland` uses `"summary"`. Drop `useExpandedTests`, `truncated`. |
| `packages/dashboard/src/app/pages/run-detail.tsx`               | Pure-derive `summary = buildRunSummary(run)` from already-loaded run row. Async `testsSeedPromise = loadRunResultsPage(...)` for the tests island seed. Pass `summary`/`initialTests`/`initialNextCursor`/`initialTail` separately.                    |
| `packages/dashboard/src/app/pages/runs-list.tsx`                | Switch to `composeRunSummaryBatch` (pure, no DO hop). `RunRowProgressIsland` initial prop is now `RunSummary`.                                                                                                                                         |
| `packages/dashboard/src/__tests__/run-progress-cap.test.ts`     | Deleted.                                                                                                                                                                                                                                               |
| `packages/dashboard/src/__tests__/run-summary.test.ts` (new)    | Pure tests for `buildRunSummary` + `composeRunSummaryBatch`.                                                                                                                                                                                           |
| `packages/dashboard/src/__tests__/run-tests-tail.test.ts` (new) | `composeRunTestsTail` ordering / limit / runId scoping / status normalisation.                                                                                                                                                                         |
| `packages/dashboard/src/__tests__/run-detail-scoping.test.ts`   | Updated mocks to point at the new functions (`buildRunSummary`, `loadRunResultsPage`).                                                                                                                                                                 |
| `packages/dashboard/src/__tests__/runs.test.ts`                 | Comments updated to reference the new compose functions; scripted-result counts unchanged.                                                                                                                                                             |
| `packages/dashboard/src/__integration__/tenant-ingest.test.ts`  | Asserts on `"summary"` and `"tests-tail"` keys instead of `"progress"`. Calls `composeRunSummary` + `composeRunTestsTail`.                                                                                                                             |
| `packages/dashboard/src/__integration__/entrypoint.ts`          | Comment updated to reference `broadcastRunUpdate`.                                                                                                                                                                                                     |

No DB migration. No schema change.

### Why broadcasts are now `await`ed (not fire-and-forget)

The earlier ingest-hot-path-perf worklog moved broadcasts to fire-and-forget
(`broadcastRunProgress(scope, runId).catch(() => {})`) on the assumption that
the realtime channel is best-effort and the next batch would re-sync. In
practice that assumption doesn't hold — Workers' local runtime (workerd)
terminates the orphaned promise as soon as the response returns, so the
broadcast never reaches the DO. Symptom in dev: `setState` never fires,
so the WS subscriber's `getState` returns `undefined` on subscribe and no
subsequent push frames arrive. Refresh shows updated data because SSR
reads the tenant DB directly, not the realtime DO state — masking the
broadcast failure.

The fix is to `await` the broadcast on the request critical path. This
re-introduces a per-batch latency cost, but the new payload makes it
acceptable: one run-row read + top-50 testResults read (in parallel) +
two `setState` RPCs (in parallel) — ~2 DO RTTs in production. The prior
pass's fire-and-forget rationale assumed the broadcast cost was high
enough to need offloading; with the in-flight cap + delta pass plus
this split, it's now small enough to live on the hot path.

`bumpTeamActivity` (control DB) keeps its fire-and-forget pattern — it
writes to a different DB and is genuinely best-effort (a missed bump
just affects the watchdog's idle-team detection on the next sweep).

### Running → terminal reconcile

`RunTestsIsland` watches `summary.status` and on the running→terminal
transition bumps a `reconcileTrigger` that re-runs the cursor-paginated
REST loop from cursor=null, replacing the local `paged` state with the
canonical tenant-DB set.

Why it's needed: the live tail is `LIMIT TESTS_TAIL_SIZE ORDER BY
createdAt DESC, id DESC`. With openRun's plannedTests prefill, every
testResults row gets a near-identical createdAt (the prefill batch),
so the tail is effectively the last N rows by ULID. As tests complete
mid-run, their rows are UPDATEd in place — the createdAt doesn't
change. For a run with > TESTS_TAIL_SIZE tests, the rows outside the
tail window receive UPDATEs that the live channel never broadcasts.
Without a reconcile, the user would see those rows stuck on `queued`
until a manual refresh.

The reconcile only fires once, and only on the actual transition
(not on a terminal-on-mount). The tenant DB is canonical; this is
the same code path SSR uses for the initial tests seed.

### Known gap: mid-run staleness for runs > 50 tests

For runs with more tests than `TESTS_TAIL_SIZE`, status flips on rows
outside the tail window aren't visible during the run — only after
the running→terminal reconcile. The summary tiles still reflect
correct counts (those come from the run-row aggregates, not the tail).

Fine for the common Playwright case (≤50 tests). If this becomes a
real-world UX problem, follow-ups in rough order of effort:

1. Increase `TESTS_TAIL_SIZE` (cheap; just makes the broadcast a bit
   bigger).
2. Broadcast only the rows changed in the current batch — `tests-tail`
   becomes an event stream, the client merges by id. Smaller payload,
   but reconnect/missed-batch handling needs explicit catch-up
   (currently rwsdk's `getState` only returns the _last_ setState).
3. Add an `updatedAt` column to `testResults` and order the tail by
   it — schema change, fixes the root cause cleanly.

## Verification

| Check                                                 | Result                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                      | Passes (dashboard + reporter).                                                                                                                                                                                                                                |
| `pnpm --filter @wrightful/dashboard test`             | 20 files / 196 tests pass.                                                                                                                                                                                                                                    |
| `pnpm --filter @wrightful/dashboard test:integration` | 2 files / 8 tests pass (real workerd + miniflare DOs).                                                                                                                                                                                                        |
| `pnpm --filter @wrightful/reporter test`              | 6 files / 81 tests pass.                                                                                                                                                                                                                                      |
| `pnpm lint`                                           | 0 errors. 39 pre-existing warnings, all in untouched files.                                                                                                                                                                                                   |
| `pnpm format`                                         | Clean.                                                                                                                                                                                                                                                        |
| Manual UI smoke                                       | Not run by the agent — user runs `pnpm dev` themselves. Needs a check that (a) summary tile updates don't re-render the test list visibly mid-ingest, (b) >200-test run paginates correctly, (c) test card status flips during ingest reflect via tail merge. |
