# 2026-07-04 — Run-detail Tests tab: paginate by group, chips from the live summary

## What changed

The run-detail **Tests tab** used to load the _entire_ run into memory: the SSR
loader seeded the first 200 test rows, then `useRunRoom`'s `backfill` effect
back-paginated **every** remaining page (200–500 rows each) from `GET /results`
into a client `byId` accumulator, and the component derived both the row list
**and** the filter-chip counts (All/Failed/Flaky/Passed/Skipped) from that
growing set. On a 2000-test run this fired ~10 sequential requests and the chip
counts visibly ticked 200 → 2000 as each page landed — flooding Postgres and the
network for data the user mostly never scrolled to.

This reworks the tab into a **two-level, paginate-by-group** read that matches
how the UI actually reads the data:

1. **Filter chips → the live run summary.** The `runs` row already stores
   live-accurate `totalTests/passed/failed/flaky/skipped` (incremented per ingest
   batch, broadcast on the `void/ws` `progress.summary`). The chips now read that
   (`currentSummary`) instead of counting loaded rows — instant, whole-run-correct,
   live, **zero row reads**. The bucket math is identical (`STATUS_BUCKET_MEMBERS`
   is derived from the same `STATUS_BUCKETS` the chips collapse by), and
   `totalTests === count(*)` holds at every point of a run (the prefill seeds
   `totalTests = plannedTests.length` to match the inserted queued rows).

2. **Group headers → a server "skeleton".** `loadRunGroupSkeleton` runs one
   `GROUP BY <axis>` (`file` / `projectName` / `shardIndex`) with
   `count(*) FILTER (WHERE status IN <bucket>)` per bucket and a
   `failed*4 + flaky*2` severity, ordered worst-first in SQL. It reuses
   `STATUS_BUCKET_MEMBERS` / `statusMatchSql` so the header counts can't drift
   from the run-level aggregate. Rides the existing `(projectId, runId)` index;
   group cardinality is small (~100 files) so the aggregate is cheap. Fetched via
   TanStack `useQuery`; changing the group-by axis / status chip / search
   re-fetches it **server-side** (search is a trigram-backed `ILIKE` on
   title+file).

3. **Rows → lazy, per expanded group.** `loadRunResultsPage` gained an optional
   `group: {axis,key}` + `statusBucket` + `search` predicate; the `(createdAt,id)`
   cursor is unchanged (stable). Each expanded group is a `useInfiniteQuery`
   (infinite-scroll for a huge group) whose rows merge on top of the live `byId`
   overlay and sort worst-first client-side. Collapsed groups cost nothing but
   their header.

The SSR loader now returns the skeleton + the first row page of the
auto-expanded worst groups (server-flagged `expandedByDefault`) — one initial
fetch, everything else on interaction.

### Live behaviour

Chips update from the streamed `summary`. Group headers/order stay correct by
refreshing the (cheap) skeleton **while the run is running**, on an event-driven
**throttle** (at most once per `LIVE_STALE_MS`; a trailing debounce would starve
under a burst and a fixed interval would poll forever on a missed terminal
event), plus one final refresh when the run flips terminal, plus a query
invalidation on WS reconnect (the reseed empties the `byId` overlay, and the Void
loader refresh doesn't touch TanStack caches). Terminal runs cache their skeleton

- rows indefinitely (`staleTime: Infinity`). Rows in expanded groups update
  through the `byId` overlay and render in the server's `(createdAt, id)`-desc
  order (id-desc client sort) so infinite-scroll pages never reorder above the
  viewport. The old eager back-paginate loop is gone.

Auto-expand is a one-shot latch on the server's `expandedByDefault` flag; a run
watched live from empty waits for the first failed/flaky group before latching
(so a passing fallback expansion can't consume the latch and hide later
failures) — the guard the old client engine had, preserved.

### Why on-the-fly and not a materialized rollup

A per-`(run, axis, groupKey)` rollup table was considered and **deliberately
deferred**: it would add a second delta path to the hot ingest transaction, a
membership-drift correctness surface (the `/results` upsert can rewrite
`file`/`shardIndex`), 3-axis write amplification, and prefill-seeding
complexity — to win only for very large runs _watched live by many viewers_, a
speculative audience. The on-the-fly aggregate is correct-by-construction and
touches ingest zero. `loadRunGroupSkeleton` is the seam a rollup would slot
behind unchanged (same signature + `RunGroupSkeleton` shape) if telemetry ever
shows large live runs hurting; `MAX_RUN_GROUPS` logs the breach that would
signal it.

## Details

| File                                     | Change                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/run-groups-page.ts`             | **New.** `loadRunGroupSkeleton`, `groupAxisColumn`, `groupPredicate` (null→`IS NULL` / empty-file), `testSearchPredicate`, `RunGroupSkeleton`/`RunGroupHeader`, `MAX_RUN_GROUPS`.                                                                                                       |
| `src/lib/run-results-page.ts`            | `LoadRunResultsOpts` gained `group`, `statusBucket`, `search`, `skipOwnershipCheck`. Cursor untouched.                                                                                                                                                                                  |
| `src/lib/ingest.ts`                      | Exported `statusMatchSql` (reused by the skeleton + row bucket filter).                                                                                                                                                                                                                 |
| `src/lib/group-tests-by-file.ts`         | Added `rawGroupKey` / `groupKeyId` / `groupLabel` (server↔client group-key contract); **removed** the now-dead client group engine (`groupAndSortTests`/`countByStatusGroup`/`selectDefaultExpandedKeys`/`groupKeyFor`/`groupSeverityScore`/`severityOf`) the server skeleton replaced. |
| `routes/api/.../runs/[runId]/groups.ts`  | **New** GET route → `loadRunGroupSkeleton`.                                                                                                                                                                                                                                             |
| `routes/api/.../runs/[runId]/results.ts` | Added `groupBy`/`groupKey`/`statusBucket`/`search` query params.                                                                                                                                                                                                                        |
| `pages/.../runs/[runId]/index.server.ts` | Loader seeds skeleton + auto-expanded group row pages (parallel) + `isSharded` (from `run.expectedShards`); dropped `tests`/`testsCursor`.                                                                                                                                              |
| `pages/.../runs/[runId]/index.tsx`       | Passes the new props to `RunProgress`.                                                                                                                                                                                                                                                  |
| `src/components/run-progress.tsx`        | Rewrite: chips from summary; headers from the skeleton `useQuery`; per-group rows via `useInfiniteQuery` + `byId` overlay; throttled live skeleton refresh + terminal + reconnect invalidation; one-shot server-driven auto-expand with the live-from-empty guard.                      |
| `src/realtime/use-run-room.ts`           | Removed the eager back-paginate loop + `backfill` option; keeps summary + live `byId`. (`mergeBackfilledTests` removed from `run-progress.ts`.)                                                                                                                                         |

No schema change, no migration.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm check` (vp check: oxfmt + oxlint + type-aware) — **0 errors** (121
  pre-existing warnings, all in `packages/e2e` fixtures, untouched).
- `pnpm --filter @wrightful/dashboard test` (both lanes) — **239 + 1125 passed**
  (workers count is down from 1145 because the dead-code removal took ~20
  now-orphaned unit tests with it).
- New tests:
  - `pg-integration.test.ts` → a `run-group skeleton (grouped read)` block that
    executes `loadRunGroupSkeleton` + the group-filtered `loadRunResultsPage`
    against real Postgres SQL (pglite/node-postgres): worst-first ordering,
    per-bucket counts (`timedout ∈ failed`), `expandedByDefault`, status + search
    filters, the shard/null-key fallback, and the int8→number coercion.
  - `group-tests-by-file.workers.test.ts` → `rawGroupKey` / `groupKeyId` /
    `groupLabel` pin the server↔client group-key contract.
- **Not run here (flag for follow-up):** the dashboard Playwright suite
  (`pnpm --filter @wrightful/e2e test:dashboard`). `run-detail.spec` +
  `realtime.spec` should still pass (row-link selector unchanged; the realtime
  results all share `live.spec.ts` → one auto-expanded group, so the 0→3 count
  holds via the `byId` overlay + debounced refetch within Playwright's retry).
  `visual.spec`'s `run-detail.png` baseline may need `--update-snapshots` if the
  Tests-tab render shifted.

### Adversarial review + fixes applied

An 8-angle review of the diff (correctness / removed-behavior / cross-file / SQL
/ live-realtime / reuse / altitude / conventions) ran before finalizing. SQL and
cross-file passes were clean (aggregates coerced, injection-safe, all callers
survive the optional-opt signature changes). The live-path + altitude passes
found real issues, all fixed here:

- **Live skeleton refresh was a per-event trailing debounce** → starved during a
  burst and could poll forever if a terminal WS event was missed. Replaced with
  an event-driven throttle + terminal-transition refresh (above).
- **Auto-expand latch** could be consumed by a passing fallback group on a
  live-from-empty run, hiding later failures. Restored the `seededNonEmpty` /
  `hasBadGroup` guard.
- **Reconnect** no longer re-hydrated (empty overlay + untouched caches). Added a
  reseed-triggered query invalidation.
- **Row display order** (severity) fought the `(createdAt, id)` cursor → scroll
  jank on paginated groups. Now sorts by `id` desc to match the cursor.
- **Cleanup:** env-tab loader no longer fans out the group-row queries; the two
  route validators share one `GROUP_BY_AXES` / `STATUS_BUCKET_KEYS` source; the
  dead client group engine + its tests removed.

Not fixed (accepted by design, documented in code): during a live run the three
count surfaces (chips / headers / rows) are only eventually-consistent, and a
live row whose group isn't yet in the skeleton appears on the next throttled
refresh (≤`LIVE_STALE_MS`). Worst-first ordering is preserved at the group level
but is now recency (not severity) _within_ a group — a possible follow-up is a
server-side severity cursor.
