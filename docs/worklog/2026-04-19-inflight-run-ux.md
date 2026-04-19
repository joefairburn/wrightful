# 2026-04-19 — In-flight run UX: relative paths, running indicator, progress count

## What changed

Three UX fixes for the streaming-ingest experience surfaced by watching a
slow e2e spec stream to the dashboard:

1. Reporter sends **relative** test file paths (stripped against Playwright's
   `rootDir`) instead of absolute machine-local paths.
2. Runs with status `"running"` now get a dedicated pulsing primary-color
   dot + "Running" label in both the list and detail views, instead of
   collapsing into the gray fallback shared with `skipped`.
3. Reporter captures and streams an `expectedTotalTests` count at `onBegin`
   (from `suite.allTests().length`). The dashboard persists it and renders a
   `{done}/{expected}` progress pill on the runs list and a `N / M` Total
   tile on the run detail page while a run is in flight.

## Details

| Area                                                        | Change                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/index.ts`                            | Track `rootDir` from `FullConfig`; thread it to `buildPayload` which now relativizes via `node:path`. Include `expectedTotalTests` on the open-run payload.                         |
| `packages/reporter/src/types.ts`                            | `OpenRunPayload.run` gains `expectedTotalTests: number`.                                                                                                                            |
| `packages/reporter/src/__tests__/aggregation.test.ts`       | New cases for relative-path behavior and the null-rootDir fallback.                                                                                                                 |
| `packages/dashboard/src/routes/api/schemas.ts`              | `RunMetaCommon` gains optional nullable `expectedTotalTests`.                                                                                                                       |
| `packages/dashboard/src/routes/api/runs.ts`                 | `openRunHandler` persists the new column.                                                                                                                                           |
| `packages/dashboard/src/db/schema.ts`                       | `runs.expectedTotalTests` nullable column + mirrored on the `committedRuns` view.                                                                                                   |
| `packages/dashboard/drizzle/0000_colossal_sinister_six.sql` | Fresh initial migration via `db:generate` (per the squash convention) + hand-appended `CREATE VIEW committed_runs` including the new column. Replaces `0000_lonely_queen_noir.sql`. |
| `packages/dashboard/src/app/pages/runs-list.tsx`            | `STATUS_DOT.running` variant + progress pill rendered in the Tests cell when `status === "running"`.                                                                                |
| `packages/dashboard/src/app/pages/run-detail.tsx`           | `STATUS_DOT.running` + `STATUS_LABEL.running` + Total tile renders `{totalTests} / {expectedTotalTests}` while running. `SummaryTile.value` widened to `React.ReactNode`.           |

## Migration rationale

Pre-launch we squash the initial migration rather than stacking new ones
(memory: `feedback_pre_launch_migrations.md`). Adding the
`expected_total_tests` column required editing the 0000 migration; drizzle-
kit doesn't diff `sqliteView("…").existing()` views, so the generated SQL
omits the `CREATE VIEW` and it's appended by hand at the end of the file —
same pattern used for the original `committed_runs` view introduction.

The drift probe added earlier (`scripts/setup-local.mjs`) wipes local D1
automatically on the next `setup:local` because the migration tag changed
and the probe's fallback path triggers.

## Verification

- `pnpm typecheck` — clean (dashboard + reporter).
- `pnpm --filter @wrightful/reporter test` — new relative-path cases pass.
- `pnpm test` — 78/79 dashboard tests pass. One pre-existing failure in
  `run-detail-scoping.test.ts` (`Maximum call stack size exceeded` in
  drizzle entity proxy) is unrelated; it fails identically on the
  pre-change tree.
- `pnpm lint` / `pnpm format` — clean.
- End-to-end streaming smoke with the `slow.spec.ts` spec:
  - `runs.expected_total_tests = 5` persisted (matches the spec's test
    count).
  - `test_results.file = "slow.spec.ts"` (relative), not an absolute path.
  - While in flight, the runs list shows a pulsing primary dot plus a
    `0/5` → `1/5` → … progress pill; the detail page reads "Running" and
    shows `N / 5` in the Total tile.

## Not done / observations

- The slow.spec.ts `describe.configure({ mode: "serial" })` + `retries: 1`
  combo in the demo causes each non-failing test in the describe to emit
  twice (playwright retries the whole describe), which inflates
  `total_tests` beyond `expected_total_tests`. This is a Playwright
  semantics quirk, not a reporter bug — noted here for anyone who wonders
  why `9 / 5` can show up on a completed run.
- Live/auto-refresh is still out of scope; the user refreshes to observe
  progress. A small `<meta http-equiv="refresh">` or polling hook is the
  natural follow-up.
