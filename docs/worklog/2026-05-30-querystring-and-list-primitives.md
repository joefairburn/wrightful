# 2026-05-30 — Query-string href builder, branch-param decode, shared search input & numeric sparkline

## What changed

Five list/insights/filter primitives that had been smeared across the
`/t/:teamSlug/p/:projectSlug/*` page family were concentrated behind small,
mostly-pure seams. These are deduplication wins — each seam replaces an
idiom that had been copy-pasted (and in places had silently drifted) across 4–8
call sites.

- **F48 — scalar query-string href builder.** Almost every list/insights page
  hand-rolled the same closure: seed a `URLSearchParams` from the current scalar
  params (range / branch / segment / q / page / tab), apply a one-key override,
  and stringify with a conditional `?` guard. The closures had drifted — some
  kept the `qs ? … : pathname` guard, some emitted a bare trailing `?`; some
  dropped keys on a `null` override, some only ever set. New `makeHrefBuilder`
  (`src/lib/page-links.ts`) owns all three behaviours — "omit empty/absent
  params", "override one key (null deletes)", and the conditional `?` — in one
  place, exposing `.with(overrides)` and a `.pageHref(n)` where "page 1 drops the
  `page` key" lives once. Adopted in tests, slowest-tests, flaky, insights/index,
  run-duration, suite-size, and runs/[runId] (the tab-href path). The runs-list
  page deliberately stays on its richer `toSearchParams(RunsFilters)` builder.

- **F51 — branch-param decode.** The `!raw || raw === ALL_BRANCHES ? null : raw`
  decode was re-written in 6 analytics loaders. It now lives as `parseBranchParam`
  in `run-history-branch-filter.shared.ts`, co-located with the `ALL_BRANCHES`
  sentinel it interprets, so the value and its decode rule have a single owner.
  The run-detail loader is intentionally NOT migrated — it decodes a missing
  param as the run's own branch, not no-filter.

- **F17 — raw-SQL filter fragments.** The `branch ? sql\`and runs.branch = …\`
  : sql\`\``ternary (plus flaky's conditional-join sibling and the
title/file`LIKE`search ternary) were inline in the raw-SQL analytics loaders.
Extracted to`src/lib/analytics/filters.ts`as`branchFragment`,
`branchJoinFragment`, and `searchFragment`— all keeping the value as a BOUND`sql` parameter, never interpolated, so injection-safety is preserved.

- **F49 — shared search-filter input.** The sticky-toolbar magnifier + compact
  search input markup (the long `h-7 … border-line-1 pl-8 … focus-visible:ring`
  Tailwind string) was copy-pasted across tests, run-progress, and
  runs-filter-bar's bespoke `RunsSearchInput`. Extracted to a presentational
  `SearchFilterInput` (`src/components/search-filter-input.tsx`) that owns only
  the visual shell and forwards native input props, so each caller keeps its own
  behaviour (GET-form name/defaultValue, controlled value/onChange, debounced
  navigate). **Also fixed a shipped bug**: flaky.tsx rendered a visually identical
  search input with no `name`, no `<form>`, and no handler — typing in it did
  nothing. Since flaky.server.ts has no `q` searchParam support, the dead input
  was removed (rather than wiring half a feature).

- **F53 — numeric line sparkline consolidation.** The page-private
  `DurationSparkline` in slowest-tests.tsx was a third numeric-line sparkline
  duplicating `MetricSparkline`'s job with a different point shape.
  `MetricSparkline` was extended to accept explicit `{x, y}` `points` (alongside
  the index-spaced `values` fast path), an `area?` toggle, and an `ariaLabel`,
  and absorbed `DurationSparkline`'s degenerate-count handling. The x/y
  projection math was lifted into a pure, exported `numericSparkline()` so it is
  unit-testable without rendering. `DurationSparkline` is deleted; slowest-tests
  passes real `day` values as `x` so sparse days still render as gaps (index
  spacing would have been a silent regression). The `sparkline.tsx` comment that
  pointed at the now-removed `DurationSparkline` was updated to point at
  `MetricSparkline`.

## Details

| File                                                                                                                             | Change                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/page-links.ts`                                                                                                          | New — `makeHrefBuilder(pathname, current)` → `{ with, pageHref }`.                                                                |
| `src/lib/analytics/filters.ts`                                                                                                   | New — `branchFragment` / `branchJoinFragment` / `searchFragment` raw-SQL fragment helpers.                                        |
| `src/components/search-filter-input.tsx`                                                                                         | New — presentational `SearchFilterInput` + `searchFilterInputClassName()`.                                                        |
| `src/components/run-history-branch-filter.shared.ts`                                                                             | Added `parseBranchParam(raw)` next to `ALL_BRANCHES`.                                                                             |
| `src/components/analytics/metric-sparkline.tsx`                                                                                  | Added `points`/`area`/`ariaLabel`/`className` props; extracted pure `numericSparkline()` geometry; paint via `currentColor`.      |
| `src/components/sparkline.tsx`                                                                                                   | Doc comment now points at `MetricSparkline` (was `DurationSparkline`).                                                            |
| `src/components/run-progress.tsx`, `src/components/runs-filter-bar.tsx`                                                          | Adopt `SearchFilterInput`.                                                                                                        |
| `pages/.../{tests,flaky,insights/index,insights/run-duration,insights/slowest-tests,insights/suite-size,runs/[runId]/index}.tsx` | Adopt `makeHrefBuilder`; tests adopts `SearchFilterInput`; flaky drops dead search input; slowest-tests calls `MetricSparkline`.  |
| `pages/.../{tests,flaky,insights/index,insights/run-duration,insights/slowest-tests,insights/suite-size}.server.ts`              | Adopt `parseBranchParam`; raw-SQL loaders adopt the filter fragments.                                                             |
| `src/__tests__/page-links.test.ts`                                                                                               | New — param preservation, null-drop, conditional `?`, page-reset.                                                                 |
| `src/__tests__/parse-branch-param.test.ts`                                                                                       | New — sentinel/empty → null, real branch passthrough.                                                                             |
| `src/__tests__/analytics-filters.test.ts`                                                                                        | New — empty-fragment collapse + bound-param injection safety for all three fragments.                                             |
| `src/__tests__/numeric-sparkline.test.ts`                                                                                        | New — 0/1-point degenerate descriptors, real-x spacing, padded-box projection, area-close path, flat-series divide-by-zero guard. |

### Behaviour parity / intentional shifts

- The slowest-tests duration cell renders via `MetricSparkline` with `area={false}`
  to keep its line-only look; the previous `DurationSparkline` had no area fill.
- `flaky.tsx`'s search input is removed, not migrated — it never functioned
  (no name/form/handler) and flaky.server.ts has no `q` support, so removing the
  dead control is the honest fix.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (no errors).
- Dashboard vitest — **368 passed (34 files)**, up from the ~192 baseline, including
  the four new test files for this cluster.
- Reporter vitest — **150 passed (11 files)**, unaffected.
- `pnpm check` — 0 errors, 77 (pre-existing, e2e/reporter) warnings. The
  format pass reflowed `metric-sparkline.tsx` and `run-history-branch-filter.shared.ts`.
