# 2026-05-03 — Ingest hot-path perf: decouple, incrementalize, cap

## What changed

Three coordinated changes to the streaming-ingest hot path
(`POST /api/runs/:id/results`, called per Playwright batch) so per-batch
work no longer scales with run size:

1. **Broadcast moved off the request critical path.** `broadcastRunProgress`
   was awaited after each ingest write — it re-read the entire `runs` row
   plus the entire `testResults` set for the run, then `setState`'d on the
   realtime DO. For a 1k-test/20-batch run that's ~25k cumulative row reads
   and 2 sequential DO hops added to every response. Now fire-and-forget
   via `.catch(() => {})`, matching the established pattern of
   `bumpTeamActivity`.
2. **Incremental run aggregates.** `aggregateRecomputeStatement` ran 5
   correlated `SELECT COUNT(*)` subqueries per batch. Replaced in
   `appendResultsHandler` with a delta `UPDATE runs SET passed = passed +
?, …` whose values are derived from each row's pre/post status. The
   full recompute is retained in `completeRunHandler` as a reconciliation
   pass to absorb any drift.
3. **Capped live progress payload.** `composeRunProgress` and
   `composeRunProgressBatch` now order by `(createdAt DESC, id DESC)` and
   `LIMIT LIVE_TESTS_CAP` (1000). The `RunProgress` payload gains
   `truncated: boolean` + `totalTests: number` so consumers can tell when
   they're seeing a window. Net effect: a 10k-test run no longer bloats
   broadcasts or SSR seeds.

A new dashboard endpoint and consumer fall back to the full set when the
cap is exceeded:

- `GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/results` — cursor
  paginated by `(createdAt, id)`, optional `?status=` filter, default
  limit 200, max 500.
- `RunProgressTests` (the test-list card) accepts a `resultsEndpoint`
  prop; when `progress.truncated` it fetches all pages once and merges
  with the synced-state slice (synced wins on overlap so live updates
  override the static set).

## Details

| Item                                    | Before                                                                                   | After                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `await broadcastRunProgress(...)`       | 2 sequential DO hops on every ingest response                                            | Fire-and-forget; response returns as soon as the batch commits                                                  |
| `aggregateRecomputeStatement` per batch | 5 correlated subqueries scanning `testResults`                                           | Single incremental `UPDATE` from the batch payload; full recompute kept only in `completeRun`                   |
| `composeRunProgress` test list          | Full unbounded scan, ordered by SQLite default                                           | `ORDER BY createdAt DESC, id DESC LIMIT 1000`                                                                   |
| `composeRunProgressBatch`               | Single `WHERE runId IN (...)` against `testResults`                                      | One capped query per run in parallel (per-run cap means we can't safely use a shared `IN` predicate)            |
| `RunProgress` payload                   | `tests[]` was the full set; queued count derived from `tests[].filter(... === "queued")` | `tests[]` capped; `totalTests` and `truncated` added; queued derives from `runs.totalTests - completed buckets` |

`LIVE_TESTS_CAP = 1000` is exported from `progress.ts`. Picked to cover
the long tail of real-world Playwright runs while keeping the broadcast
payload bounded at the 10k-test scale. Easy to tune later without
contract changes.

### Why N parallel queries instead of `IN (...)` for the batch path

The original `composeRunProgressBatch` collapsed N sequential hops into
one. With the per-run cap it's no longer safe to batch by `runId IN
(...)` — one giant run could starve the others within a global limit.
Tried the `ROW_NUMBER() OVER (PARTITION BY runId …)` route, but Kysely's
SQLite dialect can't infer a typed row shape through the windowed
subquery, and the cast-around looked worse than just issuing N queries
in parallel. The TenantDO serializes them locally, so wall-clock cost
is roughly one round-trip; only callers (runs-list SSR, run-detail SSR)
are typically batching ≤20 running rows.

### Why incremental aggregates work without an extra read

`resolveTestResultIds` already pre-flights a `SELECT id, testId WHERE
runId = ? AND testId IN (...)` to decide insert vs. update. Extended it
to also fetch `status`. That gives every result in the batch a known
prev-status (or `undefined` for fresh inserts), which is enough to
compute the delta:

| Transition                             | totalTests | bucket counts                  |
| -------------------------------------- | ---------- | ------------------------------ |
| insert (no prev row)                   | +1         | +1 final-bucket (0 if queued)  |
| update from `queued` → final           | 0          | +1 final-bucket                |
| update from non-queued → new status    | 0          | -1 prev-bucket, +1 next-bucket |
| same bucket (e.g. `failed → timedout`) | 0          | 0                              |

`completeRunHandler` still emits the full-recompute statement at the end
of the run as a safety net. If we ever introduce a code path that
mutates `testResults.status` outside `appendResultsHandler` it must
either touch the aggregates itself or trigger a recompute.

### Why no `waitUntil`

rwsdk's `AppContext` doesn't expose Workers' `ExecutionContext`. The
existing `bumpTeamActivity` (control DB) uses unawaited promises with a
`.catch(() => {})` swallower; the broadcast follows the same pattern.
Without `waitUntil` the runtime _may_ terminate the broadcast before it
completes, but the realtime channel is best-effort by design ("any
error here is logged but never propagated" per the existing comment) —
the next ingest batch's broadcast or the watchdog will re-sync.

## Code fixes / migrations

| File                                                              | Change                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/routes/api/runs.ts`                       | `resolveTestResultIds` now also returns `prevStatusByTestId`; `aggregateDeltaStatement` + `computeAggregateDelta` added; `appendResultsHandler` uses the delta UPDATE; broadcasts fire-and-forget. |
| `packages/dashboard/src/routes/api/progress.ts`                   | `LIVE_TESTS_CAP` exported; `RunProgress` gains `totalTests` + `truncated`; `composeRunProgress` orders + limits; `composeRunProgressBatch` issues one capped query per run.                        |
| `packages/dashboard/src/routes/api/run-results.ts` (new)          | `runResultsHandler` — cursor-paginated GET for the full testResults set.                                                                                                                           |
| `packages/dashboard/src/worker.tsx`                               | Wire `runResultsHandler` at `/api/t/:teamSlug/p/:projectSlug/runs/:runId/results`.                                                                                                                 |
| `packages/dashboard/src/app/components/run-progress.tsx`          | `useExpandedTests` hook fetches overflow pages when `truncated`; `RunProgressTests` and `RunTestsIsland` accept `resultsEndpoint`.                                                                 |
| `packages/dashboard/src/app/pages/run-detail.tsx`                 | Pass `resultsEndpoint` through `RunTestsSection`.                                                                                                                                                  |
| `packages/dashboard/src/__tests__/aggregate-delta.test.ts` (new)  | Pure tests for `computeAggregateDelta` covering each transition.                                                                                                                                   |
| `packages/dashboard/src/__tests__/run-progress-cap.test.ts` (new) | `composeRunProgress` cap + truncated flag + queued-count derivation.                                                                                                                               |
| `packages/dashboard/src/__tests__/run-results.test.ts` (new)      | Auth, scoping, cursor decode, lookahead-based `nextCursor`.                                                                                                                                        |

No DB migration. No schema change.

## Verification

| Check                                     | Result                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                          | Passes (dashboard + reporter, both green).                                                                                                                                                                                                                 |
| `pnpm --filter @wrightful/dashboard test` | 19 files / 186 tests pass. 19 new tests across the three areas.                                                                                                                                                                                            |
| `pnpm lint`                               | 0 errors. 33 pre-existing warnings, all in untouched files.                                                                                                                                                                                                |
| `pnpm format`                             | Auto-fixed; clean.                                                                                                                                                                                                                                         |
| Manual e2e + UI smoke                     | Not run by the agent — user runs `pnpm dev` themselves; needs a quick manual check that the run-detail page renders the test list correctly during ingest and after a run completes (especially with a >1000-test run, where the new pagination kicks in). |
