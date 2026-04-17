# 2026-04-17 — Migrate dashboard pages to Tailwind + Base UI

## What changed

First consumers of the `app/components/ui/` library. Before this, the dashboard had the stack wired (Tailwind v4, 54 `ui/` wrappers, `cn()` helper, `NuqsAdapter` mounted) but zero pages using it — every page still rendered with inline `style={{...}}` and hardcoded hex colors.

Every page under `packages/dashboard/src/app/pages/` has been re-skinned onto the new stack, plus the shared `status-badge.tsx` component. No new features, no filters, no sort UI, no nuqs. Pure re-skin.

**Architectural rule enforced:** pages remain RSC. `"use client"` lives inside the `ui/` wrapper leaves that need it; it never bubbles up to a page root.

## Files touched

| File                                                      | Shape of change                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard/src/app/components/status-badge.tsx`  | Swapped inline `<span style={{color}}>` for `Badge` wrapper with a status → semantic-variant map.                                                                                                                                                                              |
| `packages/dashboard/src/app/pages/login.tsx`              | Wrapped body in `Card`; `Field`/`FieldLabel`/`Input`(`nativeInput`) for the form; `Button` for submit + GitHub (via `render={<a />}`); `Alert` for error banner; `Separator` for the "or" divider. Form still posts via `method="post"` + FormData — no client boundary added. |
| `packages/dashboard/src/app/pages/runs-list.tsx`          | `Table` family for the run list; `Empty` family for the no-runs state; semantic token colors (`text-success-foreground`, etc.) on the tests-count cell. Container capped at `max-w-6xl`.                                                                                       |
| `packages/dashboard/src/app/pages/run-detail.tsx`         | Summary as a `Card` + `CardPanel` flex row with a local `Stat` helper; results as `Table` family; per-failure error rows as `Alert` inside a `colSpan=4` cell. "Run not found" fallback branch restyled consistently while in the file.                                        |
| `packages/dashboard/src/app/pages/not-found.tsx`          | Plain container + `h1` + muted `p` + link. No wrappers needed.                                                                                                                                                                                                                 |
| `packages/dashboard/src/app/pages/team-picker.tsx`        | `Empty` family for no-teams state with `Button render={<a href=.../>}` for the create action. Team list as `ul` with `divide-y border-y` + hover tint.                                                                                                                         |
| `packages/dashboard/src/app/pages/project-picker.tsx`     | Same list pattern as team-picker — keeps the two pickers visually consistent.                                                                                                                                                                                                  |
| `packages/dashboard/src/app/pages/test-history.tsx`       | Flakiness summary wrapped in `Card` + `CardPanel`; local `pctColorClass(pct)` helper maps % to semantic token. Results as `Table` family; status column swapped from colored text to `StatusBadge` for parity with runs-list. `DurationChart` + `Sparkline` left as-is.        |
| `packages/dashboard/src/app/pages/test-detail.tsx`        | Tags as `Badge variant="info"`, annotations as `Badge variant="warning"`. Per-failure error block as `Alert variant="error"` with `AlertTitle` + `AlertDescription`. Artifact type labels as `Badge variant="outline" size="sm"`.                                              |
| `packages/dashboard/src/app/pages/admin/teams.tsx`        | `Table` family; `Button render={<a href="/admin/teams/new"/>}` for the create action.                                                                                                                                                                                          |
| `packages/dashboard/src/app/pages/admin/team-new.tsx`     | Form wrapped in `Card` + `CardPanel`; `Field`/`Input`(`nativeInput`)/`Button`; `Alert` for the error banner. Handler unchanged.                                                                                                                                                |
| `packages/dashboard/src/app/pages/admin/project-new.tsx`  | Same pattern as `team-new.tsx`.                                                                                                                                                                                                                                                |
| `packages/dashboard/src/app/pages/admin/team-detail.tsx`  | Projects + members rendered as `ul` with `divide-y border-y`; `Button render={<a/>}` for the create-project action.                                                                                                                                                            |
| `packages/dashboard/src/app/pages/admin/project-keys.tsx` | Revealed-key banner as `Alert variant="success"` with `<pre>` inside `AlertDescription`; mint form as inline `Field` + `Input` + `Button`; keys `Table` with `Badge` status (success=active, error=revoked); revoke as `Button variant="destructive-outline" size="sm"`.       |

## Status → Badge variant map (applies to `status-badge.tsx`)

Using existing `Badge` variants — no new variants added to `ui/badge.tsx`.

| Playwright status | Variant     | Rationale                                                              |
| ----------------- | ----------- | ---------------------------------------------------------------------- |
| `passed`          | `success`   | Direct match.                                                          |
| `failed`          | `error`     | Soft destructive tint; bold `destructive` reserved for action buttons. |
| `timedout`        | `error`     | Grouped with failure.                                                  |
| `flaky`           | `warning`   | Amber — closest to prior orange.                                       |
| `interrupted`     | `warning`   | No purple variant exists. `warning` conveys abnormal-end.              |
| `skipped`         | `secondary` | Filled muted pill — reads as inactive.                                 |
| _(fallback)_      | `outline`   | Unknown server values.                                                 |

`lib/status.ts` (the hex color table) is intentionally untouched — still consumed by `sparkline.tsx` and `duration-chart.tsx`, which remain out of scope (SVG internals).

## Design choices worth flagging

Defaults shipped; open to pushback at review time.

1. **Login / team-new / project-new wrapped in `Card`** — gives the forms a sheet-of-paper look conventional for auth and creation flows.
2. **`run-detail` error rows remain grouped at the bottom of the results table** rather than interleaved under each failed row. Preserves today's ordering; fixing the ordering would be a behavior change, out of scope for a re-skin.
3. **`max-w-6xl` added to runs-list and run-detail containers.** Today's code had no cap — caused tables to stretch arbitrarily on wide monitors. Small readability improvement; not a feature.
4. **`test-history` status column converted from colored text to `StatusBadge`** — gives parity with the runs-list table and removes another inline-style site.
5. **`pctColorClass(pct)` helper lives inside `test-history.tsx`** (six lines). Shared scope is just that page today; not worth a new module.

## Notes for future migrations

- **`Kbd` is for keyboard shortcuts, not shell commands.** Used plain `<code>` with Tailwind utilities for the CLI hint in the runs-list empty state.
- **`Input nativeInput` is the right choice for server-side `<form method="post">`** — it renders a real `<input>` inside the styled wrapper so FormData serializes natively. Avoids needing a client-side form handler just to get the visual polish.
- **Per-component `"use client"` inventory** (for reference): `Card`, `CardPanel`, `CardHeader`, `CardTitle`, `CardDescription`, `Badge`, `Field`, `FieldLabel`, `Button`, `Input` are all client leaves. `Alert`, `AlertTitle`, `AlertDescription`, `Table`+family, `Empty`+family, `Separator` are server-renderable. Pages that only need the RSC-safe set (`Table`, `Alert`, `Empty`) stay 100% RSC with no client boundary crossed.
- **When filters arrive**, the pattern is: read URL state on the server via `createLoader`/`createSearchParamsCache` (nuqs supports RSC reads), and write URL state in small leaf `"use client"` filter-control components via `useQueryState`. Do not promote whole pages to client components.

## Verification

- `pnpm lint` — 28 warnings, 0 errors; all warnings pre-existing in untouched files (`sidebar.tsx`, `toast.tsx`, `use-media-query.ts`, `cli/src/lib/api-client.ts`, `e2e/vitest.globalSetup.ts`).
- `pnpm typecheck` — clean, both `cli` and `dashboard`.
- `pnpm test` — 128/128 (cli 83, dashboard 45).
- `pnpm format` — all migrated files pass after a single `oxfmt --write` pass.

Manual visual verification against the dev server is the next step. No visual regression tests in the repo yet.

## Remaining inline-style surface

- `duration-chart.tsx` and `sparkline.tsx` — SVG internals; legitimate `style={}` for positional and stroke attributes. Left as-is.
- `ui/sidebar.tsx` and `ui/input.tsx` — internal pass-through of caller `style` props. Correct.

No page-level inline styles remain.
