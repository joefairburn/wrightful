# 2026-07-03 — Deferred-loading skeletons: eliminate layout shift, match content

## What changed

The `defer()` skeletons landed in the [deferred-loading
foundation](./2026-07-02-deferred-loading-foundation-suite-size.md) reserved the
wrong box: every deferred region visibly **jumped** when the real data streamed
in and replaced the skeleton. This pass reworks the skeletons so each one
reserves the resolved content's box **to the pixel** and echoes its structure,
so the skeleton→content swap causes no cumulative layout shift (CLS).

### Root cause — skeleton bars ignored the real text line box

The skeletons sized text placeholders with fixed pixel heights (`h-3` = 12px,
`h-6` = 24px) that had nothing to do with the height the real text actually
occupies. In this Tailwind v4 app:

- Preflight sets the root `line-height: 1.5`.
- **Arbitrary** font-size utilities (`text-[26px]`, `text-[13px]`,
  `text-[11.5px]`, …) set _only_ `font-size` — they do **not** emit a paired
  line-height, so the text falls back to the inherited `1.5`. A `text-[26px]`
  value therefore occupies a `26 × 1.5 = 39px` line box, not 24px. (Named
  utilities like `text-sm` _do_ ship a paired line-height; arbitrary ones don't.)

So a KPI value reserved `h-6` (24px) but rendered into a 39px line box — 15px
short on that line alone. Summed across a card (label 18 vs 12, value 39 vs 24,
footnote 17.25 vs 12) each KPI card was **26px shorter** as a skeleton than as
content, and since the KPI row sits at the top of every insights page, the chart
and everything below it shoved down on resolve.

### The fix — reserve one real line box with the CSS `lh` unit

New shared helper `TextLineSkeleton` renders a shimmer bar carrying the **same
font-size class as the real text** and a height of `h-[1lh]` (one line box).
`1lh` resolves to the element's _own_ used line-height, so the placeholder
tracks the real line box for any font-size / inherited line-height with no
pixel arithmetic — the react-loading-skeleton philosophy (size relative to type,
not fixed px) expressed with a modern CSS unit. `lh` is Baseline 2023
(Chrome/Edge 109+, Firefox 120+, Safari 16.4+), well within this dashboard's
target. `KpiCardSkeleton` and the suite-size distribution headers now use it.

**Exception — `leading-none` contexts.** The bottlenecks table cells inherit
`leading-none` (line-height 1) from `TableCell`, so their `text-[13px]` /
`text-[11px]` lines render at the raw font-size, not 1.5×. There the skeleton
reserves `h-[13px]` / `h-[11px]` directly (NOT `1lh`, which would over-reserve).

Charts were already correct: `AnalyticsLineChart` / `BucketBarChart` /
`RunHistoryChart` confine their axis + label rows _inside_ the fixed `height`
box, so `ChartSkeleton height={…}` matched the resolved chart to the pixel.
Left untouched.

## Details — per-region audit (real vs old skeleton) and fix

| Region                             | Old skeleton box                 | Real box                                                                               | Δ                                | Fix                                                                                                |
| ---------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| KPI card (both insights pages)     | 90px                             | 116.25px                                                                               | **+26.25px/card**                | `TextLineSkeleton` bars at the real `text-[12px]`/`text-[26px]`/`text-[11.5px]` line boxes         |
| Bottlenecks table row × up to 20   | 53px/row                         | 51px/row                                                                               | −2px/row                         | Test cell → `h-[13px]` + `mt-0.5` + `h-[11px]` (leading-none = 26px)                               |
| Bottlenecks row **count**          | always 20                        | `bottlenecks.length` (≤20)                                                             | huge on partial/last/empty pages | reserve exact count from eager `totals.totalUniqueTests − offset`; `0` → the Empty branch          |
| Bottlenecks **pagination footer**  | _absent_                         | 57px (multi-page) / 41px (single)                                                      | **+41–57px pop-in**              | footer-shaped placeholder (`border-t px-6 py-3`; page-strip only when `totalPages > 1`)            |
| Suite-size distribution header     | `h-4`/`h-3`, wrong `mt-1.5`      | `text-[13px]`/`text-[11.5px]`, `mt-0.5`                                                | +~5px + wrong gap                | `TextLineSkeleton` + `mt-0.5`                                                                      |
| Suite-size distribution row        | 24px                             | 26px                                                                                   | +2px/row                         | `text-xs` label line + `mt-1` + `h-1.5` bar (mirrors `DistributionRow`)                            |
| Suite-size tag pill                | `h-[20px]`                       | 22px                                                                                   | +2px/pill                        | `h-[22px]` (18px inline line box + `py-px` + 1px borders)                                          |
| Run-detail history chart title row | `items-baseline`, `h-3` subtitle | `items-center`, 21.25px (title baseline-aligned with the ~20.5px branch-filter button) | +4.5px → +1.25px → **0**         | `items-center` + pin the row to `h-[21.25px]` (the exact real height; two flat bars maxed at 20px) |

## Code fixes / migrations

- **`src/components/skeletons.tsx`** — added `TextLineSkeleton` (`1lh` line-box
  helper + a doc block explaining the sizing rule and the `leading-none`
  exception); rewrote `KpiCardSkeleton` to reserve the three real line boxes;
  modernized the (unused) `ListRowsSkeleton` to the same helper; `ChartSkeleton`
  left as-is (already exact).
- **`pages/…/insights/suite-size.tsx`** — imported `TextLineSkeleton`; rewrote
  `DistributionSkeleton` (header line boxes + `mt-0.5`, 26px rows, 22px pills).
  Row/pill counts stay representative, not exact — the real counts are only
  known once the deferred query resolves and this is the **last** card on the
  page, so a differing resolved count resizes this card in place without
  shifting anything else.
- **`pages/…/insights/slowest-tests.server.ts`** — return `offset` + `pageSize`
  (both eager) so the page can compute the exact skeleton row count without
  duplicating `PAGE_SIZE` or importing server-only constants into the client
  bundle.
- **`pages/…/insights/slowest-tests.tsx`** — compute `bottlenecksRowCount` from
  the eager totals; parameterized `BottlenecksSkeleton({ rowCount, totalPages })`
  with an Empty branch, leading-none row heights, and the footer placeholder.
- **`pages/…/runs/[runId]/index.tsx`** — `RunHistoryChartSkeleton` title row →
  `items-center`, then **pinned to `h-[21.25px]`** — the real row's exact height
  (the `text-sm` title baseline-aligned with the `py-0.5` + `text-[11px]`
  branch-filter button renders to a fractional 21.25px that flat `h-*` bars,
  maxing at 20px, can't reserve). A follow-up on user report of a residual
  186px→187.25px shift; the plot grid is pinned to `height: 120` in both states,
  so the drift was isolated to the title row by box arithmetic (`187.25 − 166`
  chrome `= 21.25`), not the SVG.

## Verification

- `void prepare && tsgo --noEmit` (dashboard `typecheck`) — **0 errors**. The new
  loader props (`offset`, `pageSize`) flow through `InferProps` to the page and
  the parameterized `BottlenecksSkeleton` typechecks.
- `pnpm check` (oxfmt + oxlint + type-aware) — **0 errors**, 120 warnings all
  pre-existing in unrelated files (`error-cause.ts`, e2e helpers); none in the
  five changed files.
- `pnpm --filter @wrightful/dashboard build` — **built cleanly** (the `h-[1lh]`
  arbitrary utility compiles; deferred bundles unaffected; postbuild D1/WS
  patches ran).
- Method: box-exact audit of each deferred region (real content component vs
  skeleton) accounting for Tailwind v4's `line-height: 1.5` + arbitrary-size
  behaviour, cross-checked against a best-practice review (web.dev CLS,
  react-loading-skeleton, the CSS `lh` unit). Runtime confirmation on the dev
  server is the user's next step.

## Residual / notes

- **Variable-length terminal lists** (suite-size distribution) can't be made
  count-exact — their length is what the deferred query computes. They're the
  last element on the page, so their in-place resize contributes ~no CLS; the
  per-row/header/pill boxes are exact.
- **`lh` support** is version-pinned to the Baseline-2023 floor. If a
  pre-2023 engine ever mattered, the `1lh` bars would collapse; the fallback is
  to pin `leading-*` on both the text and the skeleton and reserve a matching
  fixed height.
- The bottlenecks row-height fix depends on `TableCell` keeping `leading-none`;
  a comment in `BottlenecksSkeleton` records the coupling.
- `RunHistoryChartSkeleton`'s `h-[21.25px]` is a font-metric-derived constant
  (title baseline + branch-filter button). If that control's padding/`text-*` or
  the base font changes, re-measure the real title row and re-pin. A comment on
  the div records where the number comes from.
