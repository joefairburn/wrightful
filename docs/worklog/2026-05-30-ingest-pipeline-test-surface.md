# 2026-05-30 — ingest pipeline: make the three run-scoped entry points a unit-test surface (F04)

## What changed

The streaming-ingest pipeline's three run-scoped entry points —
`openRun` / `appendRunResults` / `completeRun` (`src/lib/ingest.ts`) — ARE the
deep module of this subsystem: each hides verify-ownership → resolve ids →
compose a heterogeneous `db.batch` → extract the summary from the LAST batch row
→ bump team activity → broadcast. The leaf pure helpers each already had their
own suite (`computeAggregateDelta`, `mergeRunStatus`, `buildChangedTests`,
`summaryFromBatchResults`, `reconcileAndBroadcast` — see the sibling worklog
`2026-05-30-ingest-internals.md`), but the _orchestration glue that wires them
together_ was reachable only by booting a real run. A maintainer changing batch
ordering, the no-delta SELECT swap, or the ownership short-circuit got zero unit
signal.

This finding (F04) is **test-surface only — no production change**. It is the
first concrete consumer of the tracked-but-unbuilt real-D1 harness noted at the
end of the sibling worklog ("no real-D1 harness… exercised end-to-end only by
e2e"). Rather than stand up a full SQLite/miniflare D1 binding — `better-sqlite3`
ships transitively but its Drizzle driver has **no `batch`**, which is the
pipeline's atomicity boundary — it reuses the project's already-established
_mock-the-D1-boundary_ idiom (`db-batch.test.ts`, `reconcile-and-broadcast.test.ts`,
`merge-run-status.test.ts`): `vi.mock("void/db", …)` with the query builders as
controllable thenables and `db.batch` as a spy, plus `vi.mock("@/live", …)` for
`publishRunUpdate`. The three entry points are now driven through their existing
`TenantScope`-in / typed-outcome-out interface.

## Details

New file `apps/dashboard/src/__tests__/ingest-pipeline.test.ts`. The mock makes
every builder method (`from`/`set`/`where`/`limit`/`values`/`returning`/
`onConflictDoNothing`/`innerJoin`) return the same chainable node, and each node
is also a thenable: statements that are **directly awaited** (the idempotency /
ownership SELECTs, `resolveTestResultIds`' SELECT, `bumpTeamActivity`'s UPDATE,
the single-chunk prefill INSERT) dequeue from a per-test `awaitResults` FIFO;
statements **pushed into `db.batch([...])`** are never awaited, so the `batchSpy`
return value alone decides what the batch yields. This cleanly separates the
"read" results a path awaits from the batch's result array.

Invariants pinned (all verified to fail under a deliberate mutation):

| Entry point        | Invariant pinned                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `openRun`          | fresh open batches run-insert + prefill atomically and broadcasts the inline initial snapshot                |
| `openRun`          | duplicate `idempotencyKey` returns `{ duplicate: true }` with NO run insert and NO broadcast…                |
| `openRun`          | …yet still prefills this shard's planned rows (`onConflictDoNothing`), single-chunk awaited vs multi-batched |
| `appendRunResults` | ownership miss → `{ kind: "notFound" }`, no batch, no broadcast                                              |
| `appendRunResults` | a real delta appends the delta `UPDATE` LAST; the broadcast summary === `batchResults[last][0]`              |
| `appendRunResults` | a no-op delta swaps the LAST statement to a summary `SELECT` (the `deltaStmt ?? select` branch)              |
| `appendRunResults` | run vanished mid-batch (empty final row) → `{ kind: "notFound" }`, no broadcast                              |
| `appendRunResults` | `clientKey` → assigned id is threaded into the returned mapping                                              |
| `completeRun`      | ownership miss → `{ kind: "notFound" }`, no batch, no broadcast                                              |
| `completeRun`      | status-flip FIRST + recompute LAST in one batch; returns the merged status off the recompute's row           |
| `completeRun`      | recompute matched no row → falls back to `payload.status`, no broadcast                                      |

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — 0 errors.
- `vp test run src/__tests__/ingest-pipeline.test.ts` — 11/11 pass.
- Full dashboard suite (`vp test run`) — 171/171 pass, no regressions (the new
  file's module-scoped `vi.mock("void/db")` does not leak; vitest isolates mocks
  per test file).
- **Mutation checks (teeth):** forcing the summary to always be a `SELECT`
  (breaking the delta-LAST contract) fails the "real delta appends UPDATE LAST"
  test; deleting `completeRun`'s `if (!owner[0]) return notFound` guard fails the
  completeRun ownership test. Both confirm the suite catches glue regressions.
- **Remaining integration gap:** the D1 transaction's _atomicity_ (durable
  decision #10) and the live SQL that executes `mergeRunStatusSql` /
  `aggregateRecomputeStatement` are still exercised end-to-end only by e2e — the
  boundary is mocked here, by design. What this closes is the
  assembly/ordering/summary-extraction/ownership glue that the leaf pure-helper
  suites could not reach.
