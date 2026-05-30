# 2026-05-30 — Collapse the forked `OutcomeMix` into the canonical `OutcomeBar`

## What changed

The tests-catalog page (`pages/t/[teamSlug]/p/[projectSlug]/tests.tsx`) carried a
private `OutcomeMix` component that was a near-verbatim fork of the shared
`OutcomeBar` (`src/components/outcome-bar.tsx`): same four segments in the same
`passed → flaky → failed → skipped` order, same proportional-width math, same
`role="img"` + aria-label pattern, same rounded track. Two implementations of one
visualization meant a fix to one (zero-total handling, a11y text, theme-awareness)
would not reach the other (finding **F52**).

`OutcomeMix` is deleted. The catalog row now renders `<OutcomeBar>`, which is the
lone canonical stacked-status-bar (its three callers: run list, run detail, and now
the tests catalog).

To absorb the two behaviours `OutcomeMix` had that `OutcomeBar` lacked, `OutcomeBar`
gained two optional, default-noop props:

- `emptyDash` — when every bucket (and any `total` override) is zero, render a muted
  em-dash instead of an empty track. Off by default, so the run-list/run-detail
  callers are unchanged.
- `maxWidth` — px cap (replaces `OutcomeMix`'s `max-w-[180px]`). Unset = no cap.

The proportional-segment layout and the zero-total emptiness check were extracted into
two pure, exported functions — `outcomeBarSegments()` and `isOutcomeEmpty()` — so the
width math, segment order, `total`-override denominator, and divide-by-zero guard are
unit-testable without rendering.

## Details

| File                                           | Change                                                                                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/outcome-bar.tsx`               | Added `outcomeBarSegments()` + `isOutcomeEmpty()` pure seams; added `maxWidth`/`emptyDash` props; component now composes the pure helpers.                                                                                         |
| `pages/t/[teamSlug]/p/[projectSlug]/tests.tsx` | Deleted `OutcomeMix`; the Mix cell renders `<OutcomeBar emptyDash height={6} maxWidth={180} minWidth={0} … />`. `mixToneColor` switched from the (now-removed) `STATUS_COLORS` to `statusToken()`. Dropped now-unused `cn` import. |
| `src/__tests__/outcome-bar-segments.test.ts`   | New — pins segment order, proportional widths, `total` override, zero-total guard, registry-sourced colours, and `isOutcomeEmpty`.                                                                                                 |

This also removed the last reference to `STATUS_COLORS` (which the sibling status-registry
work, F50, had already deleted from `lib/status.ts`); the catalog page was the final
consumer and now sources every colour through the theme-aware `statusToken()`.

### Behaviour parity / intentional shifts

- Track colour for the catalog bar moves from `bg-muted` to `OutcomeBar`'s `bg-bg-3`.
  In light mode these are identical (`--muted` = `--bg-3`); in dark mode the catalog
  bar's track now matches the run-list/run-detail bars (a deliberate consolidation).
- The catalog bar's aria-label word order standardises onto `OutcomeBar`'s
  `passed/failed/flaky/skipped`; the visualization is unchanged.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (no errors).
- Dashboard vitest — **335 passed (30 files)** for the full
  status-taxonomy-registry cluster, including the new `outcome-bar-segments.test.ts`.
  Existing `status-registry.test.ts` unaffected.
- `pnpm check` — 0 errors, 76 (pre-existing) warnings.
