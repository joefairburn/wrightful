# 2026-05-04 — Changes-only broadcasts: drop the tail snapshot

## What changed

`tests-tail` is now an event stream of "rows that changed in this
batch" instead of "newest 50 rows by createdAt." The server builds the
broadcast payload in-process from `payload.results` in
`appendResultsHandler` — no DB read on the broadcast hot path. The
client maintains a local `Map<testResultId, RunProgressTest>`
accumulator as the source of truth for the displayed test list and
merges each tail push into it.

This closes the >50-test mid-run blind spot from the prior pass: with
`openRun`'s `plannedTests` prefill, all `testResults` rows share a
near-identical `createdAt`, which made the old "top-50 by createdAt"
tail effectively a fixed cohort. UPDATEs to rows outside that cohort
never reached the live channel. Now every changed row is broadcast in
the batch it occurs in, regardless of position.

| Item                                     | Before                               | After                              |
| ---------------------------------------- | ------------------------------------ | ---------------------------------- |
| `tests-tail` content                     | top-50 by `createdAt DESC, id DESC`  | rows changed in current batch only |
| Per-batch broadcast payload (typical)    | ~10 KB (50 rows × ~200 B)            | ~200 B – 2 KB (1–10 rows × ~200 B) |
| DB reads on broadcast hot path           | run row + testResults top-50 (2 RTT) | run row only (1 RTT)               |
| Mid-run live updates for rows >50 deep   | invisible until completion           | visible per-batch                  |
| Client display source                    | `mergeTailOverPaged(paged, tail)`    | `Map<id, RunProgressTest>`         |
| Per-row update history across pushes     | only most recent 50 rows persisted   | persisted forever in client Map    |
| `openRun` and `completeRun` `tests-tail` | full top-50 query                    | skipped (`changedTests = []`)      |

## Approach

Server (`progress.ts` + `runs.ts`):

- `broadcastRunUpdate(scope, runId, changedTests: RunProgressTest[])`
  takes the tail rows directly. When `changedTests.length > 0` it
  pushes `{ tests: changedTests, updatedAt }` on `"tests-tail"`. When
  empty (openRun, completeRun) it skips the `tests-tail` setState
  entirely so it doesn't overwrite the prior batch's rows that a fresh
  subscriber would otherwise pick up via `getState`.
- `appendResultsHandler` builds `changedTests` via `buildChangedTests`
  (exported, pure) from `payload.results` + `assignedIds`. The IDs are
  already computed by `resolveTestResultIds`, the field set already
  matches what gets persisted to `testResults` — no new DB hop.

Client (`run-progress.tsx`):

- `RunTestsIsland` switches its state model to a single
  `Map<string, RunProgressTest>` accumulator:
  - Mount: seed Map from `initialTests` (SSR REST page).
  - `usePaginatedTests` is gone; replaced by an effect that paginates
    forward from `initialNextCursor` and merges each page into the
    Map (one-shot per mount).
  - Tail push: merge `tail.tests` into Map (latest-wins). Persists
    across subsequent `setState` replacements because the Map lives in
    React state, not in the synced-state value.
  - Reconcile (running→terminal): refetch all REST pages from
    `cursor=null` and _replace_ the Map (not merge), so any stragglers
    that weren't broadcast — disconnected clients, crash recovery,
    out-of-tail UPDATEs from edge code paths — get reconciled from
    canonical tenant DB state.
- `mergeTailOverPaged` removed; replaced by `mergeIntoMap` + `buildMap`
  helpers.
- `initialTail` prop removed from `RunTestsIsland` — no longer used
  for anything visible. The `useSyncedState` hook is still seeded with
  `{ tests: [], updatedAt: 0 }` so the React state has a starting
  shape; the accumulator is the display source.

`run-detail.tsx`: drops the `initialTail`/`TESTS_TAIL_SIZE` slice
construction. SSR passes the REST seed straight through.

## Trade-off / known limitation

`useSyncedState`'s `getState(key)` only returns the _last_ `setState`'s
value — there's no rwsdk-side log of intermediate batches. So a
WebSocket disconnect that spans multiple batches loses the
intermediate batches' updates from the live channel: on reconnect
`getState` returns batch N's rows but batches N-1, N-2, … are gone.
The client's accumulator keeps whatever it had pre-disconnect, so
rows updated before the disconnect stay correct; the gap is rows that
flipped status _during_ the disconnect.

The running→terminal reconcile catches this at run end. For brief
WS hiccups (rwsdk's auto-reconnect typically completes within
seconds), the next batch's broadcast lands and merges in normally.

We considered adding a reconnect-triggered reconcile via
`onStatusChange`, but that API isn't in rwsdk's public exports
(`exports` map only exposes `client` + `worker` subpaths, not
`client-core`). Skipped for now; can revisit if rwsdk exposes the
status hook or if reconnect-window staleness becomes a real
user-reported issue.

## Code fixes / migrations

| File                                                                 | Change                                                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/routes/api/progress.ts`                      | `broadcastRunUpdate(scope, runId, changedTests)`. Empty `changedTests` skips the `tests-tail` setState.                                         |
| `packages/dashboard/src/routes/api/runs.ts`                          | New `buildChangedTests(results, assignedIds)` (exported). `appendResults` passes `buildChangedTests(...)`. `openRun` + `completeRun` pass `[]`. |
| `packages/dashboard/src/app/components/run-progress.tsx`             | `RunTestsIsland` → `Map` accumulator. `mergeTailOverPaged` + `usePaginatedTests` removed. `initialTail` prop removed.                           |
| `packages/dashboard/src/app/pages/run-detail.tsx`                    | Drops `initialTail`/`TESTS_TAIL_SIZE` slice construction.                                                                                       |
| `packages/dashboard/src/__tests__/build-changed-tests.test.ts` (new) | Pure tests for `buildChangedTests` (id resolution, field passthrough, null normalisation, ordering).                                            |
| `packages/dashboard/src/__tests__/runs.test.ts`                      | Comments updated (broadcast hot path is one DB read now, not two).                                                                              |

`composeRunTestsTail` and `TESTS_TAIL_SIZE` remain exported from
`progress.ts` because the integration test still uses
`composeRunTestsTail` to verify post-completion DB state. Production
code no longer calls them.

No DB migration. No schema change.

## Verification

| Check                                                 | Result                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                      | Passes (dashboard + reporter).                                                                                                                                               |
| `pnpm --filter @wrightful/dashboard test`             | 21 files / 202 tests pass (6 new in `build-changed-tests.test.ts`).                                                                                                          |
| `pnpm --filter @wrightful/dashboard test:integration` | 2 files / 8 tests pass.                                                                                                                                                      |
| `pnpm lint`                                           | 0 errors. 41 warnings (2 over pre-existing baseline; all pre-existing in `reporter/client.ts` + `setup-local.mjs`, none from this change).                                   |
| `pnpm format`                                         | Clean.                                                                                                                                                                       |
| Manual UI smoke                                       | Not run by the agent. User to run `slow.spec.ts` and a synthetic >50-test run; confirm test cards stream in live regardless of position; confirm completion reconcile fires. |
