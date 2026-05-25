# 2026-05-25 — Void structural redesign (sidebar, theme, filter bar)

## What changed

Restructured `packages/dashboard-void/` to match the Wrightful design
prototype (Linear/x.ai-flavored, cool blue-neutral oklch palette). This pass
is **structural only** — sidebar, header, theme, and the runs filter bar.
Individual page bodies are unchanged.

The prototype is at https://api.anthropic.com/v1/design/h/ftGsvKkOQpC_TN4_keV-zQ
(extracted locally during the planning phase to `/tmp/design-prototype/wrightful/`).

### Sidebar absorbs the header

- Deleted the top `<header>` strip (project switcher + bell + help + user
  avatar). Notifications and help icons were never wired up and aren't in
  the prototype.
- New 240px sidebar layout in `src/components/app-layout.tsx`, top to
  bottom: `WorkspaceSwitcher` → ⌘K "Jump to…" button → primary nav → footer
  Settings link → footer `SidebarUserMenu`. Layout is now in-flow flex
  (`flex h-screen` with no `ml-64`) instead of a fixed sidebar + offset main.
- Insights gets a sub-nav (Pass rate / Run duration / Slowest tests / Suite
  size) that only renders when `/insights/*` is active.
- Settings shell shares the same chrome; only the middle section swaps to
  the account/teams tree.

### Workspace switcher (single trigger, two sections)

- New `src/components/workspace-switcher.tsx` replaces both `TeamSwitcher`
  (was at top of sidebar) and `ProjectSwitcher` (was in the top header).
  Single button shows team color tile + team name + project name (mono);
  popover lists Teams then Projects-in-team. "New project" footer is gated
  by `isOwner`.
- Both `src/components/team-switcher.tsx` and
  `src/components/project-switcher.tsx` were deleted.

### Theme system (dark/light with no FOUC)

- New `middleware/01.head.ts` sets `headDefaults` per Void's head-management
  API: `htmlAttrs: { class: "dark" }` (default = dark, matching prototype)
  plus an inline `<script>` that reads `localStorage.theme` and toggles the
  `.dark` class on `<html>` **synchronously**, before first paint. Tailwind
  v4's `@custom-variant dark (&:is(.dark *))` keys off this. This was the
  Void-blessed path per `node_modules/void/.../docs/guide/pages-routing/head.md`.
- New `src/components/theme-toggle.tsx` flips the class + writes
  localStorage. Mounted as a row inside `SidebarUserMenu`'s popover.
- Rewrote `SidebarUserMenu` from a circular-avatar header trigger to a
  full-row sidebar-footer trigger (matches prototype's user button shape).
  Popover content adds the theme toggle row above Sign out.

### Token palette remap (no rename)

- Replaced both `:root` (light) and `.dark` palettes in `src/styles.css`
  with the prototype's oklch values. **Token names are unchanged** —
  `--background`, `--foreground`, `--border`, `--sidebar`, `--accent`,
  `--primary`, etc. — so the ~57 Base UI / COSS wrappers in
  `src/components/ui/` pick up the new look without per-component edits.
- Added net-new status tokens: `--pass / --fail / --flaky / --skipped /
--running` (plus `*-soft` variants) exposed to Tailwind under
  `--color-pass`, `--color-fail`, etc. The status dots in the runs filter
  use these (`bg-pass`, `bg-fail`, `bg-flaky`, `bg-skipped`).
- Added `--accent-soft` and `--accent-line` for the prototype's restrained
  desaturated-indigo accent usage. Two new keyframes (`pulse-soft`,
  `progress-stripe`) for live-run states.
- Existing `--success` / `--destructive` / `--warning` keep their semantic
  meanings (forms, toasts) and were updated to the prototype's matching
  status colors so they read consistently with `--pass` / `--fail` /
  `--flaky`.

### ⌘K command menu

- New `src/components/command-menu.tsx` built on the existing
  `@/components/ui/command` COSS primitive. Groups: Navigate (Runs / Flaky
  / Tests / Insights / Settings), Switch project (within active team),
  Switch team. Recent runs / global test search left as a follow-up — the
  primitive supports extra groups with zero scaffolding.
- `useCommandMenuShortcut` hook handles the global ⌘K / Ctrl+K listener.
  Lifted out of the menu itself so it tracks open state via the setter
  without coupling the layout to keyboard plumbing.

### Runs filter bar restyled

- `src/components/runs-filter-bar.tsx`: the search input now lives inline
  with the dropdowns (one row instead of two stacked strips). All controls
  share `h-8`. Date-range button moved to the right side, defaulting to a
  "Last 24 hours" placeholder when empty.
- Status filter now renders an inline colored dot before each option
  (`bg-pass`, `bg-fail`, etc.). Branch options render in mono font.
- Extended `MultiComboboxFilter` in `src/components/filter-controls.tsx`
  with an optional `renderItem(value, label)` callback so the status/branch
  filters can prefix content per row without forking the primitive.
- **Multi-select behavior preserved** — the prototype uses single-select
  per facet, but we kept multi-select per the user's explicit decision.
- The runs index page (`pages/t/[teamSlug]/p/[projectSlug]/index.tsx`)
  collapses its old two-row title-strip + filter-strip into a single header
  block: title + count badge above the filter row.

## Files changed

| File                                           | Change                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `middleware/01.head.ts`                        | **New.** FOUC-killer inline script + default `.dark` class.                                           |
| `src/styles.css`                               | Remapped palettes to oklch prototype values; added status + accent tokens + pulse/progress keyframes. |
| `src/components/app-layout.tsx`                | Rewrote: no top header, in-flow 240px sidebar, mounts `CommandMenu`.                                  |
| `src/components/workspace-switcher.tsx`        | **New.** Combined team + project picker.                                                              |
| `src/components/theme-toggle.tsx`              | **New.** Reads/writes `.dark` + localStorage.                                                         |
| `src/components/command-menu.tsx`              | **New.** ⌘K command menu over COSS Command primitive.                                                 |
| `src/components/sidebar-user-menu.tsx`         | Full-row sidebar trigger; popover gains theme toggle row above Sign out.                              |
| `src/components/runs-filter-bar.tsx`           | Inline search + 4 dropdowns + right-aligned date trigger; status dots + mono branches.                |
| `src/components/filter-controls.tsx`           | Added `renderItem` callback to `MultiComboboxFilter`.                                                 |
| `pages/t/[teamSlug]/p/[projectSlug]/index.tsx` | Collapsed title + filter into one header block.                                                       |
| `src/components/team-switcher.tsx`             | **Deleted.** Superseded by `WorkspaceSwitcher`.                                                       |
| `src/components/project-switcher.tsx`          | **Deleted.** Superseded by `WorkspaceSwitcher`.                                                       |

## Decisions

- **Tokens revalued, not renamed.** Renaming would have forced edits in 50+
  wrapper components in `src/components/ui/`; revaluing lets every primitive
  pick up the new look for free. The cost is that some tokens (e.g.
  `--accent`) now carry slightly different semantics than their pre-redesign
  values, but the new semantics line up with how Base UI consumes them.
- **Inline-script FOUC strategy.** Considered cookie-based SSR theme
  rendering but skipped: Void's `headDefaults.script[].innerHTML` runs
  synchronously in `<head>` before any paint, no cookie roundtrip, no SSR
  cache invalidation, and the `geist`-style class lives on `<html>` which
  survives SPA navigation. Validated against
  `node_modules/void/.../docs/guide/pages-routing/head.md`.
- **No Geist font swap.** The `geist` npm package is installed (as a
  transitive dep of the legacy `packages/dashboard`) but it's Next-only —
  not importable in a Vite build. The prototype's typographic intent
  (precise sans + JetBrains Mono) is already covered by Inter +
  JetBrains Mono. Font swap deferred to a later pass if visual fidelity to
  the prototype matters more than current bundle stability.
- **Skipped compact-sidebar toggle.** Prototype offers a 60px compact
  variant; the user opted to ship expanded-only this pass.

## Verification

- `pnpm --filter @wrightful/dashboard-void check` — **0 errors**, 67
  warnings (all pre-existing `no-unsafe-type-assertion` in files I didn't
  touch). Format and lint pass for every file in this change.
- `pnpm --filter @wrightful/dashboard-void test` — **91 passed (7 files)**.
- `pnpm exec void prepare` — regenerated `.void/*.d.ts` cleanly; the new
  `01.head.ts` middleware is registered without warnings.
- Manual `pnpm dev` verification deferred to the user (per project
  convention; agents don't spawn the dev server). The user should confirm:
  - Default theme is dark, no flash on reload.
  - Theme toggle in user menu flips dark ↔ light and persists.
  - ⌘K opens the command menu; selecting an item navigates and closes.
  - Workspace switcher opens, shows teams + projects, switching navigates.
  - Settings shell still works (Back to app, profile, team list).
  - Runs filter bar: search debounces, all 4 multi-selects open and persist
    via URL, status dots render in option rows.
  - No top header visible anywhere; all chrome lives in the sidebar.

## Follow-ups

- Replace the static `bg-flaky-soft` count badge on the Flaky nav item with
  a real count once a server-side flaky-test count is exposed (currently
  removed from the sidebar since it was hardcoded `8` in the prototype).
- The "Last 24 hours" date-range placeholder doesn't actually filter to 24h
  yet — it's just the empty-state label on the date-range popover. A real
  preset list (24h / 7d / 30d) would close the gap with the prototype.
- Command menu's recent runs and global test search are stubs in spirit —
  the primitive supports adding groups without rework.
- Run-detail and test-detail page bodies, settings page bodies, flaky list,
  insights, and tests catalog are all unchanged. Restyling those is the
  next pass.
