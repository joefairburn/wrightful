# 2026-05-30 — Status-bucket parity guard + SQL-semantics test surface (F71)

## What changed

Finding F71 flagged that several hand-written SQL-semantics builders had no
unit-test surface, so a regression in escaping or a drift in the
status→bucket mapping was invisible until production data was wrong. This is a
testability gap, and the highest-value part of it (the status→bucket mapping)
also admitted a small genuine deepening: one source of truth instead of two
hand-kept-in-sync encodings.

1. **Status→bucket: one source of truth.** Extracted the test-status →
   aggregate-bucket mapping into a single exported constant
   `STATUS_BUCKET_MEMBERS` in `src/lib/ingest.ts`. Both code paths now derive
   from it:
   - the JS delta path — `statusBucket()` is now a lookup into a map built from
     the constant (was a hand-written `switch`);
   - the SQL recompute path — `aggregateRecomputeStatement()`'s four
     per-bucket `COUNT(*) … WHERE status …` subqueries are now built from the
     constant via a new `statusMatchSql()` helper (single-status buckets render
     `"status" = 'x'`, multi-status render `"status" IN ('x','y')`).
     The emitted SQL is byte-identical to the previous hand-written subqueries;
     only the encoding's _source_ changed. A mis-edit (e.g. dropping `timedout`
     from the failed bucket) is now structurally impossible to make on only one
     side.

2. **Exported `escapeLike`** from `src/lib/runs-filters-where.ts` (was a
   private 1-liner) so the LIKE-metacharacter escaping is directly unit-testable.

3. **Tests** for the now-reachable pure surfaces.

## Details

| File                                                      | Change                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/dashboard/src/lib/ingest.ts`                        | Added `STATUS_BUCKET_MEMBERS` (exported) + derived `STATUS_TO_BUCKET` map; `statusBucket()` now reads the map; added `statusMatchSql()`; `aggregateRecomputeStatement()` builds its bucket subqueries from the constant. |
| `apps/dashboard/src/lib/runs-filters-where.ts`            | Exported `escapeLike` (+ doc comment).                                                                                                                                                                                   |
| `apps/dashboard/src/__tests__/status-bucketing.test.ts`   | NEW. Pins `STATUS_BUCKET_MEMBERS`, asserts every member status routes to its bucket, `timedout`→failed, unknown/queued/running→null, and no status maps to two buckets.                                                  |
| `apps/dashboard/src/__tests__/runs-filters-where.test.ts` | NEW. `escapeLike` pure-string escaping; `buildRunsWhere` LIKE-pattern escaping read back via the stub's recorded `like()` args; `bucketExpr` literal-inlining (divisor in template string, zero bound args).             |

### Scope notes (verifier corrections honored)

- `aggregateRecomputeStatement` itself can't be rendered to SQL under the
  `void/db` stub (`db` is a throwing Proxy), so the parity is asserted via the
  shared constant the recompute builds from — not by executing the UPDATE. A
  live SQL-string assertion still awaits the real-D1 harness (KNOWN-OUTSTANDING).
- `bucketExpr`'s D1 text-affinity concern is a runtime property no unit test can
  prove; the test only asserts the structural precondition (divisor inlined,
  args empty), it does NOT claim to verify D1's coercion behavior.
- `currentStatusSeveritySql` / `mergeRunStatusSql` were already covered by
  `merge-run-status.test.ts` (sibling F01/F67) — no new work there.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `vp test run` (full dashboard suite) — 19 files, 183 tests passed (no
  regressions; the recompute path is exercised by `ingest-pipeline.test.ts` and
  `reconcile-and-broadcast.test.ts`, both still green after the refactor).
