# 2026-05-30 — Analytics query module: params, range/bucket parity, percentile picker, latest-per-test (F41–F46, F13, F15)

## What changed

The six analytics loaders (`insights/index`, `insights/run-duration`,
`insights/suite-size`, `insights/slowest-tests`, `tests`, `flaky`) had grown a
thick layer of copy-pasted query plumbing: the `?branch=`/`?range=` decode, the
window-start formula, the SQL bucket-key contract, a hand-rolled
discrete-percentile picker, the `testResults`→`runs` scope join + tenant
predicate, and the "latest result per test" + per-test status-counter idioms.
Each was smeared across 2–8 call sites and maintained by eye. This cluster
turns those shallow, duplicated fragments into a small set of DEEP modules under
`src/lib/analytics/`, each with a single owner and (for the pure parts) a unit-test
surface under the `void/db` stub.

1. **Request-params seam (F41)** — `src/lib/analytics/params.ts` with two pure
   functions migrated into all six loaders:
   - `normalizeBranchFilter(branchParam)` → `{ branchParam, branchFilter, branchAll }`,
     folding the `parseBranchParam` call + the `branchFilter === null`
     ("all branches") derivation into one place (keeps `parseBranchParam` as the
     sole owner of the `__all__` sentinel rule).
   - `resolveAnalyticsWindow(range, nowSec?)` applies the ONE canonical window
     formula (`windowStartSec = rangeSec == null ? 0 : nowSec - rangeSec`),
     reconciling the three drifted hand-rolled variants and removing the dead
     30-day fallback in the insights/run-duration loaders. `nowSec` is injectable
     so the window math is testable without mocking the clock.

2. **Range/bucket parity (F44, F45, F46)** — gave the `bucketing.ts` /
   `bucketing-sql.ts` split a test surface and pinned the SQL↔JS bucket-key
   contract. `alignBuckets()` is now the single home of the key-format contract
   between `bucketExpr` (SQL) and `buildEmptyBuckets`/`bucketKey` (JS); the join
   key is fixed (no caller-supplied selector) to prevent reopening the drift.
   The insights `.tsx` callers were migrated onto the shared alignment.

3. **Discrete-percentile picker (F42)** — concentrated the
   `min(case when <rn> = max(1, cast(round(<cnt> * q) as integer)) then <value> end)`
   idiom (7 hits across run-duration / slowest-tests) into `bucketing-sql.ts`,
   with the SQL day-bucket expression and `DAY_SEC` no longer redeclared in
   slowest-tests.

4. **Scope-join + filter fragments (F13)** — `src/lib/analytics/filters.ts`
   owns the most-smeared, highest-blast-radius raw-SQL idiom:
   `testResultsScopeJoin(scope)` emits `inner join runs … where tr."projectId" = ?`
   from a branded `TenantScope` (a raw `string` projectId no longer types into a
   loader — enforces the scope.ts invariant on the `db.run(sql\`\`)`path that
Drizzle's checker can't see). Plus`branchFragment`, `branchJoinFragment`, and
`searchFragment`, all emitting bound params, never interpolation.

5. **Latest-per-test + status counters (F43)** — `src/lib/analytics/per-test.ts`
   gives the `row_number() over (partition by testId order by createdAt desc)`
   ranked-CTE picker and the per-test `sum(case when status …)` counters one
   owner, with `statusPredicate` as the single home of "fail" =
   `status in ('failed','timedout')` and "flaky" = `status = 'flaky'`.

6. **Phantom-index comment removed (F15)** — `branches-query.ts:11` documented a
   composite index (`runs_project_branch_idx`) that exists nowhere in the schema.
   The misleading justification for the SELECT DISTINCT skip-scan was corrected.

## Details

| File                                                           | Change                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/lib/analytics/params.ts`                                  | NEW. `normalizeBranchFilter`, `resolveAnalyticsWindow` + `BranchFilter`/`AnalyticsWindow` types (F41).          |
| `src/lib/analytics/filters.ts`                                 | NEW seams: `testResultsScopeJoin(scope)`, `branchFragment`, `branchJoinFragment`, `searchFragment` (F13).       |
| `src/lib/analytics/per-test.ts`                                | NEW. `latestPerTestRn`, `latestPerTestValue`, `statusCounter` + `statusPredicate` single-source-of-truth (F43). |
| `src/lib/analytics/bucketing.ts`                               | `alignBuckets()` as the fixed-key SQL↔JS bucket contract home (F46).                                            |
| `src/lib/analytics/bucketing-sql.ts`                           | Discrete-percentile picker + shared SQL day-bucket expr; consumed by run-duration/slowest-tests (F42/F45).      |
| `src/lib/branches-query.ts`                                    | Removed phantom `runs_project_branch_idx` comment (F15).                                                        |
| `pages/.../insights/{index,run-duration,suite-size}.server.ts` | Migrated onto `params.ts` + `bucketing-sql.ts`.                                                                 |
| `pages/.../insights/{index,run-duration,suite-size}.tsx`       | Migrated onto shared `alignBuckets`.                                                                            |
| `pages/.../insights/slowest-tests.server.ts`                   | Migrated onto `params.ts`, `filters.ts`, `per-test.ts`, `bucketing-sql.ts`.                                     |
| `pages/.../tests.server.ts`, `pages/.../flaky.server.ts`       | Migrated onto `params.ts`, `filters.ts`, `per-test.ts`.                                                         |
| `src/__tests__/analytics-params.test.ts`                       | NEW. Branch-filter folding + window formula (incl. injected `nowSec`).                                          |
| `src/__tests__/analytics-filters.test.ts`                      | Scope-join tenant predicate + branch/search fragment bound-param assertions.                                    |
| `src/__tests__/analytics-per-test.test.ts`                     | NEW. Ranked-CTE picker + status-counter predicate parity.                                                       |
| `src/lib/analytics/__tests__/{range,bucketing}.test.ts`        | NEW. Range parsing + bucket skeleton/alignment + SQL↔JS bucket-key contract.                                    |
| `src/__tests__/runs-filters-where.test.ts`                     | Extended for the shared day-bucket expr literal-inlining.                                                       |

### Scope notes (verifier corrections honored)

- F44/F46 were narrowed from "deepening" to a test-coverage gap — the bucketing
  modules were already extracted, so no shared-divisor merge of
  `bucketing.ts` / `bucketing-sql.ts` was done; the principled split stands.
- The raw-`db.run(sql\`\`)`loaders can't be executed under the`void/db` stub,
  so the seams are asserted at the fragment level (bound params present, tenant
  predicate emitted, status predicates byte-correct). A full live-D1 query
  harness remains KNOWN-OUTSTANDING.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 38 files, 435 tests passed (up from
  the pre-cluster baseline; the cluster adds the analytics test surfaces above).
- `pnpm --filter @wrightful/reporter test` — 11 files, 150 tests passed (no
  regressions; reporter untouched).
- `pnpm check` — 0 errors, 78 warnings (all pre-existing e2e `no-unsafe-type-assertion`
  warnings, unrelated to this cluster).
