# 2026-04-16 — Phase 2 (M3): Test history page

## What changed

Phase 2 Milestone 3 — tests are now trackable across runs. The "View history" link from the test detail page lands on a new `/tests/:testId` page that shows a pass/fail timeline, a duration trend chart, a simple flakiness percentage, and the last 50 results in a clickable list. This is the first dashboard surface that reads the `test_results.test_id` column, which has been populated by the CLI since Phase 1.

Two pieces:

1. **Hand-rolled SVG chart components** — `Sparkline` (per-status coloured bars with hover tooltips) and `DurationChart` (polyline with a rolling-average reference line). Both are Server Component-safe — pure SVG, no client JS, no hydration.
2. **Test history page** — an RSC at `/tests/:testId` that queries the last 50 results for this `test_id` (joined with `runs` for branch/commit context), computes flakiness over the window, and wires the two charts into a focused view with a clickable run list.

## Design decisions

- **Hand-rolled charts, no library.** Every mainstream charting library (`recharts`, `visx`, `chart.js`) is client-only and would force the page out of RSC — introducing hydration cost and a ~50 KB+ bundle. The shapes we need (a row of coloured bars and a polyline) are a few dozen lines of SVG. Revisit when the first chart appears that actually needs interactivity.
- **Chronological order on charts, reverse-chronological on the table.** People scan charts left-to-right, so "oldest on the left" matches how we think about trends. The result list below is stack-style — newest first — because that's where someone clicks from "what happened in the most recent run?".
- **50-result window.** The existing `test_results_test_id_created_at_idx` index makes this `LIMIT 50 ORDER BY createdAt DESC` cheap. 50 is enough to visualise a week or so of a busy main-branch pipeline; a configurable window is a Phase 3/4 concern.
- **Flakiness is `(failed + flaky) / ran` over the visible window** — not Phase 3's full main-branch calculation. Keeps this page self-contained and correct-for-what-it-shows. The Phase 3 flaky test page will do the real work.
- **Renamed tests surface as "no history".** We lean on the existing testId hash behaviour documented in the PRD. The empty state explicitly calls out "renamed test/file/project" as the likely cause, so users aren't left guessing.

## Files

- **new** [packages/dashboard/src/app/components/sparkline.tsx](../../packages/dashboard/src/app/components/sparkline.tsx)
- **new** [packages/dashboard/src/app/components/duration-chart.tsx](../../packages/dashboard/src/app/components/duration-chart.tsx)
- **new** [packages/dashboard/src/app/pages/test-history.tsx](../../packages/dashboard/src/app/pages/test-history.tsx)
- **new** [packages/dashboard/src/\_\_tests\_\_/charts.test.tsx](../../packages/dashboard/src/__tests__/charts.test.tsx) — 6 tests (sparkline + duration chart: rect/circle counts, colours, empty state, labels, average reference line)
- mod [packages/dashboard/src/worker.tsx](../../packages/dashboard/src/worker.tsx) — adds `/tests/:testId`

## Verification

- `pnpm typecheck` — clean.
- `npx oxlint` — 0 errors, 7 warnings (unchanged count + 1 incidental on the template-literal label; all `no-unsafe-type-assertion` or benign).
- `npx oxfmt --check .` — clean.
- `pnpm --filter @greenroom/dashboard test` — 43 tests passing (was 37 after M2, +6 for the chart components).
- `pnpm --filter @greenroom/cli test` — 83 tests (unchanged — M3 is dashboard-only).

## End of Phase 2

Phase 2 is complete. The three milestones together land:

- CLI → R2 artifact uploads via presigned URLs (M1)
- A test-scoped debugging view with trace viewer hand-off (M2)
- Cross-run test history with sparkline + duration chart (M3)

Natural next steps per `docs/PRD.md`:

- **Phase 3** — dashboard-wide flaky test detection and trend insights (the flakiness percent on this page is a taste; Phase 3 ranks across every test).
- **Phase 4** — GitHub Action PR comments (the CLI is ready; the action is still a `console.log` stub).
- Manual end-to-end validation against a live R2 bucket — worth doing before publishing anything. An opt-in integration test gated on `GREENROOM_E2E_R2=1` would be cheap and would catch any aws4fetch / R2 SigV4 surprises.
