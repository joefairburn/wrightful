# 2026-04-23 — Flaky Tests page

## What changed

Wired up the previously-disabled "Flaky Tests" sidebar entry to a real page at
`/t/:teamSlug/p/:projectSlug/flaky`. The page ranks tests that have been flaky
in the selected time window, shows a recent-outcomes sparkline per row, and
expands to reveal the last three failure records (error message + branch + run).

## Details

| Concern           | Decision                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Flakiness formula | `flaky / (flaky + passed)` — hard failures (`failed`, `timedout`) are excluded from both numerator and denom. |
| Inclusion         | Only tests with ≥1 `status='flaky'` result in the window appear.                                              |
| Default window    | 14d. Toggle also offers 7d / 30d. Persisted via `?range=`.                                                    |
| Branch filter     | `?branch=` (defaults to `ALL_BRANCHES` — mirrors run-history filter). Wired in query; UI control TBD.         |
| Top-N             | 50 (sorted by pct desc, tiebreak by flaky count).                                                             |
| Sparkline         | Last 20 results per testId, chronological (oldest left).                                                      |

## Files

- **New** `packages/dashboard/src/app/pages/flaky-tests.tsx` — RSC page: aggregation query + per-row sparkline/failures loaders.
- **New** `packages/dashboard/src/app/components/flaky-test-row.tsx` — client island: row + expandable panel.
- **Modified** `packages/dashboard/src/worker.tsx` — new route, import.
- **Modified** `packages/dashboard/src/app/components/app-layout.tsx` — enable Flaky Tests nav entry; extend `deriveActiveNav`.

Reused: `Sparkline`, `Table*`, `Empty*`, `ALL_BRANCHES`, `getActiveProject`, `formatRelativeTime`, `cn`.

No schema changes — `testResults.testId` already indexed `(testId, createdAt)`; `status` indexed `(status, createdAt)`.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm lint` — 0 errors; 26 preexisting warnings, none introduced by this change.
- `pnpm --filter @wrightful/dashboard test` — 151/151 pass.
- Manual browser test pending (user runs `pnpm dev`): navigate to `/t/<team>/p/<project>/flaky`, toggle 7d/14d/30d, expand a row.

## Follow-ups

- Add a branch-filter UI control on the page (query already respects `?branch=`).
- Consider extracting the aggregation into a reusable helper once a second caller needs it.
- Sparkline + recent-failures issue N+1-style queries bounded by `TOP_N=50`. Fine for now; revisit with a single grouped query if it shows up in traces.
