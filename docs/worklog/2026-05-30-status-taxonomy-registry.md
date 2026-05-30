# 2026-05-30 — Unified status taxonomy registry (F50, F47)

> Part of the **status-taxonomy-registry** cluster (findings F50, F52, F47).
> The dependent stacked-bar dedup (F52) is recorded in its own sibling entry,
> `2026-05-30-outcome-bar-dedup.md`. F47 (RunProgress re-implementing grouping
> / severity-ordering inline) was reconciled as part of this work — see the
> note at the end of this entry — and needed no separate change beyond the
> registry consolidation.

## What changed

The test/run status domain (`passed` / `failed` / `flaky` / `skipped` /
`timedout` / `interrupted`) had been encoded **four** different ways across
~10 frontend modules, with no single seam:

1. **Raw hex** in `src/lib/status.ts` (`STATUS_COLORS`, e.g. `#16a34a`) —
   wholly independent of the oklch tokens in `styles.css`, so the two charts
   that consumed it (`sparkline`, `run-history-chart`) rendered visually
   different greens/reds than the rest of the UI and never themed for
   light/dark. `interrupted` was even purple (`#9333ea`) here while it
   collapsed to flaky/orange everywhere else.
2. **`var(--…)` inline literals** in `outcome-bar`, `run-progress`,
   `run-tests-popover`, `status-glyph`, `segmented-control`.
3. **Badge variants** (`success`/`error`/`warning`/`secondary`) in
   `status-badge`.
4. **Tailwind `bg-*` classes** (`bg-pass`/`bg-fail`/…) in `runs-filter-bar`.

On top of the colour split, the same maps were re-declared per component:
`STATUS_LABEL` (runs-filter-bar) + `VARIANT_LABEL` (run-tests-popover); the
worst-status order/severity map (`STATUS_ORDER` in run-progress,
`STATUS_SEVERITY` in group-tests-by-file); and the `timedout → failed`
collapse rule (run-progress ×2 count maps + filter + group score).

`src/lib/status.ts` is now the **single status registry**: one `STATUS` record
per status carrying `{ cssVar, label, badge, sortKey, groupKey }`, plus pure
accessors `statusToken()`, `statusLabel()`, `statusBadgeVariant()`,
`statusSortKey()`, `statusGroupKey()`. The hex `STATUS_COLORS` /
`statusColor()` are deleted entirely. `cssVar` is a token **name** (`--pass`);
`statusToken()` wraps it as `var(--pass)`, so `styles.css` stays the sole owner
of the oklch values and theming/dark-mode keep working.

## Details

| File                                   | Migration                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/status.ts`                    | New registry + accessors; deleted `STATUS_COLORS` (hex) and `statusColor`.                                                                                  |
| `src/components/outcome-bar.tsx`       | segment colours → `statusToken()`                                                                                                                           |
| `src/components/run-progress.tsx`      | `STATUS_ORDER` → `rowSortKey` (registry + `queued`); two count maps + filter + group score + auto-expand → `statusGroupKey`; inline colours → `statusToken` |
| `src/components/runs-filter-bar.tsx`   | `STATUS_LABEL` → `statusLabel`; `STATUS_DOT_CLASS` (Tailwind) → inline `statusToken`                                                                        |
| `src/components/run-tests-popover.tsx` | `TRIGGER_COLOR` → `statusToken`; `VARIANT_LABEL` → `variantLabel` (lowercased `statusLabel`)                                                                |
| `src/components/status-glyph.tsx`      | `COLOR_BY_STATUS` → `glyphToken` (registry + glyph-only `running`); paints via CSS `color` + `currentColor`                                                 |
| `src/components/status-badge.tsx`      | `STATUS_VARIANT` → `statusBadgeVariant`                                                                                                                     |
| `src/components/segmented-control.tsx` | dot-colour ternary → `statusToken` (keeps glyph-only `running`)                                                                                             |
| `src/components/sparkline.tsx`         | `fill={statusColor()}` (SVG attr) → `style.fill = statusToken()`                                                                                            |
| `src/components/run-history-chart.tsx` | `statusColor` → `statusToken` (already in `style`)                                                                                                          |
| `src/lib/group-tests-by-file.ts`       | `STATUS_SEVERITY` → `severityOf` (registry + `queued`)                                                                                                      |
| `pages/.../tests.tsx`                  | `STATUS_COLORS` → `statusToken` (inline `style`)                                                                                                            |
| `pages/.../insights/index.tsx`         | `statusColor` → `statusToken` (inline `style`)                                                                                                              |
| `pages/.../insights/slowest-tests.tsx` | `STATUS_COLORS` → `statusToken`; `DurationSparkline` paints via CSS `color` + `currentColor` (SVG attrs can't take `var()`)                                 |

`kpi-card.tsx` was **excluded** (per the finding's verifier note): its
`var(--pass)`/`var(--fail)` encodes a numeric delta sign (improvement vs
regression), not a Playwright status.

## Notable behaviour notes

- **SVG paint + CSS vars.** SVG presentation _attributes_ (`fill=`, `stroke=`)
  don't accept `var()`. Where colour previously flowed into an attribute
  (`status-glyph`, `sparkline`, `slowest-tests`'s `DurationSparkline`), the
  token is now applied as the element's CSS `color` and painted with
  `currentColor` (or via `style.fill`). All other sites already used inline
  `style`, where `var()` resolves directly.
- **`interrupted` now collapses to `flaky` consistently.** Previously
  `run-progress` counted `interrupted` under a stray (never-rendered) key and
  its flaky filter excluded it. The registry's `statusGroupKey` collapses
  `interrupted → flaky` (matching badge/glyph/filter-bar, which already did),
  so interrupted tests now show in flaky counts and match the flaky filter —
  the intended consolidation called out by the finding.
- **`queued`** is a live-progress in-flight state, not a Playwright outcome, so
  it stays out of the registry. The two places that order it
  (`group-tests-by-file`, `run-progress`) keep a one-line special case that
  pins it between `flaky` and `skipped`, then delegate to `statusSortKey`.
- **ingest.ts `STATUS_BUCKET_MEMBERS`** (the SQL recompute / aggregate-count
  seam, already unit-tested) was intentionally left untouched — it serves
  server-side aggregate counting, not presentation, and is a separate concern.

## F47 — RunProgress no longer re-implements grouping/severity

F47 flagged `RunProgress` for re-deriving file-grouping and worst-status
ordering inline rather than consuming the pure `group-tests-by-file` module.
That is now true in the working tree: `run-progress.tsx` delegates the whole
filter → group → order → count → auto-expand pipeline to the pure engine in
`src/lib/group-tests-by-file.ts` (`groupAndSortTests`, `countByStatusGroup`,
`severityOf`, `selectDefaultExpandedKeys`), all of which sit on top of the F50
registry accessors (`statusSortKey` / `statusGroupKey`). The island shrinks to
state + presentation, and the ordering/collapse rules became the unit-test
surface in `group-tests-by-file.test.ts`. No parallel `STATUS_ORDER` /
per-component count maps remain.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (no errors).
- `vp test run` (dashboard) — **335 passed (30 files)** (was ~192 baseline; the
  cluster adds `src/__tests__/status-registry.test.ts`, the expanded
  `group-tests-by-file.test.ts`, and `outcome-bar-segments.test.ts`).
- `vp test run` (reporter) — **150 passed (11 files)** — unaffected by this
  frontend-only cluster, confirmed not regressed.
- `pnpm check` (fmt + lint + type-aware) — **0 errors, 76 warnings** (all
  warnings pre-existing `no-unsafe-type-assertion` in untouched code).
- Grep confirms no remaining references to `STATUS_COLORS` / `statusColor`.
