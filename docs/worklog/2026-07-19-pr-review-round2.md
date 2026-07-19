# 2026-07-19 — PR #58 second review round

Follow-ups for the second round of review threads on PR #58.

## What changed

- **Re-run shard-state reset (`src/lib/ingest.ts`)** — a deterministic CI
  re-run reuses its idempotency key, but `openRun`'s duplicate path only
  bumped `lastActivityAt` / coalesced `expectedShards`. A re-run whose
  sharding changed was stranded: an unsharded `/complete` against leftover
  `expectedShards > 1` took the deferred-finalize path and never finalized;
  a changed shard total 409'd with `invalidShard` forever.
  - `reopenRunForWrites` (now exported for the pglite suites): a shardless
    duplicate open of a **terminal** run clears `expectedShards` /
    `shardExpectedTests`, re-bases `expectedTotalTests` on the new payload,
    and deletes stale `runShards` rows — all in one transaction, with the
    terminal check evaluated in SQL so a mixed-fleet shardless open of a
    still-mid-flight run can't wipe a sibling shard's backfill.
  - `applyShardExpectedTests`: a terminal re-open whose shard total differs
    from the stored `expectedShards` restarts the expected-tests map from
    `'{}'` and **replaces** the total (mid-flight opens keep the coalesce
    semantics), and stale `runShards` rows with a different `shardTotal` are
    deleted. Racing same-total sibling opens serialize on the row UPDATE;
    exactly one takes the reset arm.
- **Snapshot sandbox timing (`src/trace-viewer/components/snapshot-stage.tsx`)**
  — `SnapshotFrame` rendered its iframe on the first client render while
  `pageOrigin` was still `""`, so in separate-origin mode the snapshot
  document started loading under `allow-same-origin` only; granting
  `allow-scripts` after navigation doesn't enable scripts in the loaded
  document. The iframe now renders only once the page origin is known.
- **Docs** — `docs/PRD.md` notes `pnpm deploy:void` is the workspace wrapper
  around `void deploy`; the 2026-07-18 worklog now distinguishes "no logical
  schema changes in the follow-up commit" from the PR's index-only migration.

## Explicitly not changed

- The separate-origin trace-viewer **framing allowance** stays a deploy-side
  header the operator owns (SELF-HOSTING.md "Trace-viewer origin isolation"
  step 3): the framed documents (`bridge.html`, `snapshot.html`, vendored
  assets) are static assets whose headers the worker middleware never stamps,
  so an in-app change could not grant it; the app fails closed by design.
- The `/results` run-row `FOR UPDATE` lock keeps the blessed
  `runByIdWhere` `(projectId, runId)` predicate — the deliberate,
  documented scope shape from `src/lib/scope.ts` used by every run-by-id
  site (`runs.id` is a globally unique ULID; `projectId` is brand-checked).

## Verification

- `sharded-complete.test.ts` (12 passed, incl. 2 new re-run reset cases) and
  `pg-integration/ingest.test.ts` (16 passed, incl. changed-total reset +
  mid-flight coalesce cases) — pglite lane.
- `ingest-pipeline.workers.test.ts` duplicate-open assertions updated: the
  duplicate path now runs ONE transaction holding exactly the re-arm/reset
  `update` + `delete` pair — the guarded invariant stays "no prefill INSERTs,
  no broadcast", now asserted on the recorded statement kinds.
- Trace-viewer suites: hooks/model/origin/snapshot-pane (63 passed).
- Full `pnpm --filter @wrightful/dashboard test`: unit lane 664 passed /
  4 skipped, workers lane 1369 passed. `pnpm check`: 0 errors, 143 existing
  warnings.

No schema or migration changes.
