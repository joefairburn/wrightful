# 2026-05-30 — Ingest orchestration test surface & SQL-semantics parity guards (cluster gate)

## What changed

This cluster closes the testability gap around the ingest subsystem's deep
module — the three run-scoped entry points `openRun` / `appendRunResults` /
`completeRun` in `src/lib/ingest.ts` — and pins the pure SQL-semantics builders
that surround it. Each entry point hides a verify-ownership → resolve ids →
compose a heterogeneous `db.batch` → extract the summary from the LAST batch row
→ bump team activity → broadcast pipeline; the leaf pure helpers already had
suites, but the orchestration glue that wires them together (batch ordering, the
no-delta SELECT swap, ownership short-circuits, summary extraction) was reachable
only by booting a real run end-to-end.

Three findings were folded into this cluster:

1. **F04 — ingest entry points as a unit-test surface (test-only, no production
   change).** New `src/__tests__/ingest-pipeline.test.ts` drives `openRun` /
   `appendRunResults` / `completeRun` through their existing `TenantScope`-in /
   typed-outcome-out interface, reusing the project's established
   mock-the-D1-boundary idiom (`vi.mock("void/db", …)` with builders as
   controllable thenables + `db.batch` as a spy, `vi.mock("@/live", …)` for
   `publishRunUpdate`). Pins the assembly/ordering/summary-extraction/ownership
   invariants the leaf pure-helper suites could not reach.

2. **F71 — status-bucket parity + SQL-semantics test surface (one genuine
   deepening + pure tests).** Extracted the test-status → aggregate-bucket
   mapping into a single exported `STATUS_BUCKET_MEMBERS` constant in
   `src/lib/ingest.ts`. Both the JS delta path (`statusBucket()`, now a map
   lookup) and the SQL recompute path (`aggregateRecomputeStatement()`'s
   per-bucket `COUNT(*) … WHERE status …` subqueries, now built via a new
   `statusMatchSql()` helper) derive from it, so the two encodings cannot drift.
   Exported `escapeLike` from `src/lib/runs-filters-where.ts` so the
   LIKE-metacharacter escaping is directly unit-testable. New
   `status-bucketing.test.ts` and `runs-filters-where.test.ts`.

3. **F67 — drive the real SQL merge / status-severity encoding: already
   addressed.** No code change warranted. The executed-encoding parity guard
   (`mergeRunStatusSql` / `currentStatusSeveritySql`) was already in place from
   the earlier-cluster commit 1391525 (F01) via `merge-run-status.test.ts`, and
   F71 supplies the status-bucket half of the same concern. Recorded here for
   traceability.

## Details

| File                                                      | Change                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/ingest.ts`                        | Added exported `STATUS_BUCKET_MEMBERS` + derived `STATUS_TO_BUCKET` map; `statusBucket()` now reads the map (was a `switch`); added `statusMatchSql()`; `aggregateRecomputeStatement()` builds its bucket subqueries from the constant. Emitted SQL is byte-identical — only the encoding's source changed. |
| `apps/dashboard/src/lib/runs-filters-where.ts`            | Exported `escapeLike` (+ doc comment).                                                                                                                                                                                                                                                                      |
| `apps/dashboard/src/__tests__/ingest-pipeline.test.ts`    | NEW. Orchestration glue for the three ingest entry points (11 cases).                                                                                                                                                                                                                                       |
| `apps/dashboard/src/__tests__/status-bucketing.test.ts`   | NEW. Pins `STATUS_BUCKET_MEMBERS`, member-status routing, `timedout`→failed, unknown/queued/running→null, no double-counting.                                                                                                                                                                               |
| `apps/dashboard/src/__tests__/runs-filters-where.test.ts` | NEW. `escapeLike` escaping, `buildRunsWhere` LIKE-pattern escaping via recorded `like()` args, `bucketExpr` literal-inlining.                                                                                                                                                                               |

### Seam check (cluster gate)

The seam is real, not a pass-through. `STATUS_BUCKET_MEMBERS` is a genuine
single source of truth feeding two previously hand-kept-in-sync encodings, and
the change is exercised end-to-end through the ingest entry points
(`ingest-pipeline.test.ts` drives the recompute path). Sibling integration is
coherent: F71's refactor is covered by both `status-bucketing.test.ts`
(structural parity) and the F04 pipeline suite (the recompute path that consumes
it), and both stay green together.

### Known integration gap (carried forward)

The D1 transaction's atomicity and the live execution of `mergeRunStatusSql` /
`aggregateRecomputeStatement` are still exercised end-to-end only by e2e — the
boundary is mocked here by design (no real-D1 unit harness; `better-sqlite3`'s
Drizzle driver has no `batch`, the pipeline's atomicity boundary). What this
cluster closes is the assembly/ordering/summary-extraction/ownership glue plus
the pure status-bucket and LIKE-escape semantics.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — 0 errors.
- `pnpm --filter @wrightful/dashboard test` — 19 files, 183 tests passed
  (baseline 113; +70 across this and prior clusters).
- `pnpm --filter @wrightful/reporter test` — 11 files, 150 tests passed
  (baseline 136).
- `pnpm check` — 0 errors, 80 warnings (baseline ~83; did not balloon).
