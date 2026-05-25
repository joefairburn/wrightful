# 2026-05-25 — `dashboard-void` design-bundle port

## What changed

Ported the Claude Design "Wrightful" handoff bundle into
`packages/dashboard-void`. The bundle (HTML/JSX/CSS prototype) was attached
by the user as a reference for refining the existing Void-based dashboard.
The intent was to bring the four primary workspace screens (Runs, Flaky
tests, Tests catalog, Insights) into visual parity with the design while
keeping our Base UI primitive library and Void routing intact.

The dashboard had already adopted the design's oklch palette and status
tokens in `72d0e2e` — this pass closes the remaining gap: typeface, 4-level
token scales, unified heading pattern, filter primitive polish, and table
layouts.

## Phases

| Phase | File                                                                                                                                                                      | Change                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A     | `src/styles.css`                                                                                                                                                          | Token system port                                                        |
| B     | `src/components/page-header.tsx` (new)                                                                                                                                    | Shared `PageHeader` primitive                                            |
| C     | `pages/t/[teamSlug]/p/[projectSlug]/index.tsx` + `src/components/runs-filter-bar.tsx` + `src/components/filter-controls.tsx` + `src/components/running-spinner.tsx` (new) | Runs page header + filter polish + spinner for in-flight runs            |
| D     | `pages/t/[teamSlug]/p/[projectSlug]/flaky.tsx` + `src/components/flaky-test-row.tsx` + `src/components/kpi-inline.tsx` (new)                                              | Flaky tests page restructure                                             |
| E     | `pages/t/[teamSlug]/p/[projectSlug]/tests.tsx`                                                                                                                            | Tests catalog restructure                                                |
| F     | `pages/t/[teamSlug]/p/[projectSlug]/insights/index.tsx` + `src/components/analytics/kpi-card.tsx`                                                                         | Insights header + KPI card restyle                                       |
| G     | —                                                                                                                                                                         | Sidebar/CommandMenu verified — already matches the reference; no changes |

## Token system (Phase A)

`packages/dashboard-void/src/styles.css`:

- **Fonts**: dropped `@fontsource-variable/inter` and `@fontsource-variable/space-grotesk`, added `@fontsource-variable/geist`. `--font-sans` now points at Geist; `--font-heading` aliases it; `--font-mono` keeps JetBrains Mono.
- **Type scale**: added `--text-fs-12` … `--text-fs-48` in `@theme inline` per the design bundle's `tokens.css`. Consume via Tailwind arbitrary values (`text-[length:var(--text-fs-18)]`); the default Tailwind scale is untouched.
- **Surfaces**: added 4-level `--bg-0/1/2/3` scale (raw oklch values from `tokens.css`). Existing aliases (`--background`, `--card`, `--popover`, `--muted`, `--accent`) re-point to the bg scale so every UI primitive picks up the new values for free.
- **Foreground**: added 4-level `--fg-1/2/3/4` scale; `--foreground` → `--fg-1`, `--muted-foreground` → `--fg-3`.
- **Borders**: added `--line-1`/`--line-2`; `--border` → `--line-1`.
- **Status aliases**: added past-tense `--passed`/`--failed` (+ `-soft`) aliases so JSX from the design ports literal.
- **Shadows**: added `--shadow-sm`/`-md`/`-lg`, tuned per mode.
- **Radius**: added `--radius-r-2/4/6/8/12` to `@theme inline` for explicit radius access.
- **Density**: added `.density-compact` block (overrides `--row-h`, `--pad-x`, `--gap`). Wiring of the toggle UI is deferred.
- **Base**: added `font-feature-settings: "ss01", "cv11"`, `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility` on body. Removed the stray `font-mono` on `html` (left over from a prior commit that made the whole document mono by default).
- **`.mono` utility**: opt-in for JSX with `font-feature-settings: "calt", "ss02"`.

## Components added

- `src/components/page-header.tsx` — 19px semibold title with -0.2 tracking + composable `ReactNode` subtitle (callers pass `<mono>{project.slug}</mono> · …`) + right slot for actions/segmented controls.
- `src/components/running-spinner.tsx` — SVG quarter-arc spinner colored via `var(--running)`, replaces the pulsing blue dot on in-flight runs. Per the design chat: "the icon can just be a rotating loader rather than a blue dot."
- `src/components/kpi-inline.tsx` — compact KPI cell with uppercase tracked label + large mono tabular value; used in the flaky tests strip and reusable elsewhere.

## Filter polish

`src/components/filter-controls.tsx`: added `data-[has-value=true]:bg-muted` and `data-[popup-open]:bg-muted` to `FILTER_TRIGGER_CLASSES`. Dropdowns now visibly fill with the muted surface when active or open, matching the design's `var(--bg-2)` treatment.

## Pages

Each page now uses the shared `PageHeader` with the unified subtitle pattern: `<mono>{project.slug}</mono> · {N} <description with window>`.

- **Runs** — keep header dense; table headers downgraded from `font-mono text-[11px] tracking-wider` to the design's `text-[10.5px] font-semibold uppercase tracking-[0.5px]`. Status dot palette switched from semantic tokens (`bg-success`/`bg-destructive`) to status tokens (`bg-pass`/`bg-fail`/`bg-flaky`/`bg-skipped`). Running rows render `<RunningSpinner />` instead of a pulsing dot.
- **Flaky tests** — new KPI inline strip (Tracked tests / Avg flake rate / Worst offender) above the table. Columns reordered to match the design: Status glyph / Test (sans title + mono path) / Flake rate (colored, with "over Nd" subtext) / Nd trend (existing `Sparkline`) / Last failure (mono error excerpt) / Last seen / expand chevron. The expand row showing recent failures with full `TestErrorAlert` blocks is preserved — it's a deepening over the design that's load-bearing for triage.
- **Tests catalog** — restructured to match `TestsCatalogScreen`: sticky control row with search + branch filter + range, columns are Status dot / Test (sans title + mono path inline) / Total runs / Mix (OutcomeBar) / Avg duration / Last seen. Dropped the per-row big icon variant in favor of a single 8px dot whose color follows the worst recent outcome.
- **Insights** — Run Status Analytics header uses `PageHeader`; KPI cards restyled (label `text-[10.5px] font-semibold uppercase tracking-[0.5px]`, value `font-mono text-[26px] font-semibold tracking-[-0.2px] tabular-nums`); chart card title shifts from `text-base` to `text-[15px] tracking-[-0.1px]` and subtitle drops the mono uppercase tracked treatment. The three metrics (Pass Rate, Flakiness Rate, Total Runs) are unchanged per explicit request.

## Sidebar (Phase G)

Cross-checked `src/components/app-layout.tsx` and `src/components/workspace-switcher.tsx` against the design bundle's `shell.jsx`. Sidebar width (240px), background (`bg-1`), nav active highlight (`bg-accent` ≈ `bg-3`), and the ⌘K trigger all already match. No changes needed.

## Out of scope

- The 17 other screens in the design brief (Login, Signup, Invite, Run detail, Test detail, Settings sub-pages, Insights → duration / slowest / suite-size).
- Density toggle UI control — Phase A added the `.density-compact` CSS; wiring a toggle is deferred.
- Migrating `packages/dashboard` (rwsdk) — `dashboard-void` is the target the user named.

## Verification

- `pnpm --filter @wrightful/dashboard-void check` — **0 errors**, 67 warnings (all pre-existing `no-unsafe-type-assertion` in unrelated files: `auth.ts`, `suite-size.server.ts`, `runs/[runId]/index.server.ts`).
- Visual verification by the user via `pnpm dev` (user runs the dev server themselves).
