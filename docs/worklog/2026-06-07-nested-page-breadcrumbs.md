# 2026-06-07 — Breadcrumbs on nested pages

## What changed

Added a top-of-page breadcrumb bar to the nested drill-down pages so you can see
where you are and jump back up a level. Matches the design bundle's shell
breadcrumb (slim bordered top bar, chevron separators, 12.5px, `fg-1..4` tokens,
crumbs truncate at 280px).

- **Run detail** (`runs/[runId]`): `Runs › #<shortId>`.
- **Test detail** (`runs/[runId]/tests/[testResultId]`): `Runs › #<shortId> › <test title>`.

## Why per-page (not in the layout)

`AppLayout` is a sidebar with **no top header**, and — being shared chrome — it
can't see page-specific data (the run's short id, the test title); those live in
each page's loader props. So the breadcrumb is rendered by the page, which has
the labels. The `Breadcrumbs` component encapsulates the bar chrome so placement
stays identical across pages.

## Changes

| File                                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/breadcrumbs.tsx` (new)                  | `Breadcrumbs({ items: { label, href? }[] })` — slim bordered top bar (`h-11`, `border-b`, `px-6`). Crumbs with `href` are `@void/react` `<Link>`s (internal nav — never plain `<a>`); the last crumb is the current page (`text-fg-1 font-medium`, `aria-current="page"`, non-link). Chevron separator is the design's 11px glyph (`stroke=var(--fg-4)`, path `M6 4 L 10 8 L 6 12`). Each crumb `max-w-[280px] truncate` + `title` for the full text. |
| `pages/.../runs/[runId]/index.tsx`                      | Wrapped the page in a fragment with `<Breadcrumbs>` above the scroller (shrink-0 bar + flex-1 scroller, so the bar stays put while content scrolls).                                                                                                                                                                                                                                                                                                  |
| `pages/.../runs/[runId]/tests/[testResultId]/index.tsx` | Inserted `<Breadcrumbs>` as the first child; **removed the redundant ad-hoc "← Back to run" link** — the `#<shortId>` crumb now links back to the run.                                                                                                                                                                                                                                                                                                |

The existing `src/components/ui/breadcrumb.tsx` primitive was a near-miss (its
`text-sm` / lucide-chevron styling diverges from this design's 12.5px / `fg-N`
tokens / custom 11px chevron), so the bar is a focused component rather than a
heavy override of the primitive.

## Scope

Limited to the genuinely nested drill-downs (run → test), matching the example.
Top-level section pages (Runs list, Flaky, Tests, Insights index) are reached
directly from the sidebar, and the Insights sub-pages already navigate via their
own `InsightsTabs`, so none of those got a breadcrumb. Easy to extend later by
rendering `<Breadcrumbs>` with the appropriate `items`.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` → clean.
- `pnpm --filter @wrightful/dashboard test` → **626 passed / 57 files** (no new
  tests — the component is pure presentational markup with no branching logic
  worth a unit test).
- `pnpm check:fix` → 0 errors.
- `pnpm --filter @wrightful/dashboard build` (`vp build`) → succeeds.
- Visual to confirm after a dev restart: open a run → `Runs › #<id>` with the
  first crumb linking back to the list; open a test → `Runs › #<id> › <title>`
  with the middle crumb linking back to the run.
