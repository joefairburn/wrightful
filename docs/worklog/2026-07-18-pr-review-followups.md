# 2026-07-18 — PR review follow-ups

## Why

PR 58's automated reviews found concurrency and boundary gaps in the platform
hardening pass. The valid findings touched ingest ceilings, usage rollups,
monitor scheduling, GitHub webhook replay handling, tenant deletion, trace
origin isolation, fresh-instance bootstrap, and test-fixture cleanup.

## What changed

- Result-row caps are enforced after the per-run `FOR UPDATE` lock. The projected
  count adds only test IDs not already persisted, so a crossing batch or two
  concurrent appends cannot exceed the configured ceiling.
- Usage first writes reject deltas larger than the guarded limit. Reconciliation
  now runs at repeatable-read, snapshots the live counters, repairs unchanged
  stale overcounts downward, and carries only post-snapshot deltas onto the
  authoritative aggregates.
- Monitor compare-and-swap claims and execution inserts share one transaction.
  Queue rejections log their execution/monitor/reason before the execution is
  marked terminal.
- GitHub delivery cache reads are checks only. The marker is written after the
  installation delete succeeds; Cache API failures log and fail open.
- First-team policy checks and team inserts are serialized by a transaction-
  scoped Postgres advisory lock used by every team creation path.
- Project deletion now scopes its predicate by both team and project. Shard
  completion rejects metadata that disagrees with the run's authoritative shard
  count.
- Trace-viewer configuration is read through `void/env`, normalized to an HTTP(S)
  origin, and enables snapshot scripts only when the hosting origin is available
  and different. Malformed/same-origin/unavailable cases fail closed.
- E2E teardown restores `.env.local` before releasing its lock; reporter tests
  remove only listeners they installed. Config validation, ULID fixtures,
  URL-aware trace selectors, and self-hosting/bootstrap docs were tightened.

No schema or migration changes were required.

## Verification

- Focused dashboard suites: **111 passed** across quota, row-cap, sharding,
  webhook, trace, project teardown, billing, and usage tests.
- Focused Workers/adjacent suites: **25 passed** for scheduler/ingest/header
  seams and **37 passed** for ingest/schema/rate-limit coverage.
- Reporter clamp suite: **3 passed**.
- `pnpm check`: **0 errors**, 143 existing warnings.
- `pnpm test`: dashboard node **660 passed / 4 skipped**, dashboard Workers
  **1369 passed**, reporter **304 passed**.
- The first full-test attempt exposed missing runtime env bindings in unrelated
  trace tests. `traceViewerOrigin` now treats unavailable bindings as the safe
  same-origin default; the five affected trace suites then passed **50/50**, and
  the complete rerun passed as reported above.

The preview/E2E suites were not run.
