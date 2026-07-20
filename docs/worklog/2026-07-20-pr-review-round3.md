# 2026-07-20 — PR #58 third review round

Follow-ups for the third round of review threads on PR #58.

## What changed

- **Same-total terminal re-run reset (`src/lib/ingest.ts`,
  `applyShardExpectedTests`)** — the round-2 reset was keyed on the shard
  total CHANGING, so a terminal re-run that kept the same matrix (the most
  common CI re-run: 3 → 3) retained the previous run's `runShards` completion
  rows. Its first new shard `/complete` then saw a full completion-row count
  and finalized against the dead siblings' results.
  - The reset now latches on the terminal status alone: any terminal sharded
    re-open restarts the expected-tests map from `'{}'`, replaces
    `expectedShards`, deletes **every** previous completion row, and re-arms
    the run as in-flight (`status='running'`, `completedAt=null`).
  - Exactly-once under racing sibling opens: the transaction locks the run
    row with `for update` (same lock order as `completeShardedRun`, so a
    re-open racing a delayed shard `/complete` can't deadlock); the guarded
    `runShards` DELETE runs before the UPDATE flips the status latch, and the
    losing siblings re-evaluate against the winner's now-`running` row and
    take the coalesce arm.
  - Accepted trade-off (documented in the code): a duplicate open delayed
    past the run's finalize re-arms it and drops its completion rows, leaving
    the run for the stale-run watchdog. Reaching that path requires the run's
    idempotency key; silently mixing stale and fresh shard results on every
    same-total re-run is strictly worse.

## Explicitly not changed

- **Billing reconcile selection (`src/lib/billing/reconcile.ts`)** keeps
  `order by random() limit k`. The scanned set is Polar-LINKED teams —
  cardinality bounded by paying customers, not event data — and the sort is a
  top-k heap on a weekly cron, so the selection stays sub-second far past
  10^5 linked teams. The doc-comment now records the trade-off and the
  evolution path (a persisted keyset cursor) if the fleet outgrows it.
- **Round-2 worklog date** stays 2026-07-19: it matches the UTC author date
  of the commit it documents (`7115176`, 2026-07-19 00:15 UTC).

## Verification

- `sharded-complete.test.ts` — 13 passed, incl. the new terminal same-total
  re-run case (first new shard `/complete` stays `running`; the re-run
  finalizes on its own results only). The harness DDL helper now maps jsonb
  columns to `jsonb` (it degraded them to `text`, which the newly exercised
  `jsonb_set` merge path rejects).
- `pg-integration/ingest.test.ts` — 17 passed, incl. the new same-total
  reset case asserting the map restart, completion-row drop, and
  status/completedAt re-arm.
- `ingest-pipeline.workers.test.ts` — sharded duplicate-open statement-shape
  assertion updated to the new `delete → update` order (the `FOR UPDATE`
  lock is a read and is not recorded); the guarded no-prefill/no-broadcast
  invariant is unchanged.
- Full `pnpm --filter @wrightful/dashboard test`, which runs the Vite+ test
  runner over both lanes (`vp test run && vp test run -c
vitest.workers.config.ts`), and `pnpm check`, which runs `vp check`
  (format + lint + typecheck): 0 errors. The focused files above ran through
  the same runner (`pnpm --filter @wrightful/dashboard exec vitest run
<file>`). The Vite+ pre-commit hook ran on the commit (no `--no-verify`).

No schema or migration changes were made in this follow-up commit.
