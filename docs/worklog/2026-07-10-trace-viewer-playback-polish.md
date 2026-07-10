# 2026-07-10 — Trace viewer: playback, collapse defaults, popover clamp, syntax highlighting

Four user-reported gaps against the official Playwright viewer, fixed in one pass
(three parallel sonnet agents + orchestrator verification/correction):

1. no way to "play" the replay and progress through it;
2. action-list groups rendered expanded by default (noise buries the failure);
3. the timeline hover preview card clipped offscreen at the top of the modal;
4. the Source tab showed plain unhighlighted text.

## What changed

### Playback (`src/trace-viewer/components/timeline.tsx`)

A playback control cluster — Previous action / Play–Pause / Stop / Next action /
speed — now sits left of the timeline strip. Semantics were reverse-engineered from
the **vendored official v1.61.1 bundle** (its `defaultSettingsView` chunk ships a
playback hook) and match it: a `requestAnimationFrame` clock advances a playhead by
`elapsed × speed` (speed presets `[0.5, 1, 2]`, the official values) from the
selected action's startTime; the "nearest action" (binary search for the last action
with `startTime <= t`, snapping forward when the next action's start is strictly
closer) is selected as the playhead crosses it; playback stops at `model.endTime`;
Play at/after the last action restarts from the first; Stop selects the first
action; a manual click/drag seek pauses. A `bg-ring` playhead line renders while
playing. All state is local to `Timeline` — `trace-viewer.tsx` untouched.

**Orchestrator correction on top of the agent's version:** playback, prev/next
stepping, and click-to-seek now walk `model.filteredActions([])` (the
default-visible set) instead of `model.actions`. The raw list includes the noise
groups (`route`/`getter`/`configuration`) the action list hides by default —
selecting one lands on an action with **no row in the list** (they're filtered out
of its tree before `buildActionTree`, so the auto-reveal effect can't help), making
"Next" appear to do nothing. The bars lane still renders every action. Click-to-seek
had this trait before this change too; it's fixed for all three paths now.

### Action-list collapse defaults (`src/trace-viewer/components/action-list.tsx`)

Groups (tree items with children) now start **collapsed**, except any item whose
subtree contains a real action error (`action.error?.message` — console stats
deliberately not used): the whole chain down to the failure stays expanded, so the
red row is visible with zero digging. Implementation: `computeDefaultCollapsed`
(memoized on `rootItem`) + an `overrides` set of manual toggles applied via XOR —
so a group-chip toggle (which rebuilds the tree and its defaults) preserves the
user's manual expand/collapse choices. An effect auto-reveals on external selection
(timeline seek, playback stepping, deep link): it expands the selected action's
effectively-collapsed ancestors, never collapses anything, and intentionally does
NOT depend on `overrides` so manually collapsing the selected row's own group
doesn't fight back.

### Hover preview clamp (`timeline.tsx`)

The preview card was `bottom-full` (above the strip), but the Timeline is the
topmost element inside the replay dialog's `overflow-hidden` `DialogContent` — so
it always clipped. `onPointerMove` now measures
`containerRef.getBoundingClientRect().top`; with less than `PREVIEW_CLEARANCE`
(175px ≈ card height + padding + label + margin) of viewport above, the card flips
below the strip (`top-full mt-2`). Horizontal clamping unchanged.

### Source tab syntax highlighting (`source-tab.tsx`, `styles.css`)

Pure lezer tokenization — **no `@codemirror/*` imports**. The earlier CodeMirror
attempt was reverted because custom extensions hit "multiple instances of
@codemirror/state" under Vite dev pre-bundling; `@lezer/javascript` +
`@lezer/highlight` never touch `@codemirror/state`, so that failure mode can't
apply. `tokenizeSource` picks a dialect by extension (`ts`, `ts jsx`, `jsx`,
default — mirroring `@codemirror/lang-javascript`'s own configure calls), parses
once, and `highlightCode(…, classHighlighter, …)` emits per-line `tok-*`-classed
segments (line count proven to mirror `content.split("\n")`). Non-JS/TS extensions
and parser throws fall back to the previous plain render. Line numbers,
target-line highlight/scroll, and inline error rows are unchanged.

Palette: a scoped `.trace-source` block in `styles.css` (`@layer components`),
private custom properties flipped by `.dark`, muted oklch values on the theme's
existing hue anchors; comments dimmest (`--fg-4`, italic), operators/punctuation
`--fg-3`, variable/function names deliberately inherit.

## Details

| Item            | Value                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| New deps        | `@lezer/highlight@^1.2.3`, `@lezer/javascript@^1.5.4` (dashboard; both were already in the store as transitives of `@codemirror/lang-javascript`) |
| New test file   | `src/__tests__/trace-viewer-source-tab.test.tsx` (6 tests)                                                                                        |
| Extended tests  | `trace-viewer-timeline.test.tsx` 4 → 14, `trace-viewer-action-list.test.tsx` 13 → 19                                                              |
| Node-lane total | 375 → 397 passed (4 skipped)                                                                                                                      |

## Verification

- `pnpm check` — `Found 0 errors and 133 warnings in 707 files` (baseline).
- Dashboard node lane: **397 passed / 4 skipped**; workers lane: **1222 passed**.
- Dashboard e2e replay spec: **3/3** (real trace through the real SW; boot needs
  `DATABASE_URL` exported — the fixture only writes it into its generated
  `.env.local` when present in the process env).
- **Live browser drive** (dev server + seeded `feat/discount-codes` failed run,
  Playwright script): 15/15 checks — toolbar buttons present, Pause swaps in while
  playing, the action-list selection visibly advances during playback, speed label
  cycles, hooks groups start collapsed while the failing `expect` row is visible
  and selected by default, the hover preview card renders **below** the strip and
  fully inside the dialog bounds, and the Source tab shows `tok-keyword`/`tok-string`
  spans whose computed colors differ from the base text (screenshot-confirmed in
  dark mode).

## Known limits / follow-ups

- When a user shows a noise group via its chip, playback/stepping still skips those
  actions (the playable set is the _default_-visible one; the chip state lives in
  `ActionList`). Lifting `shownGroups` to the workbench would sync them — deferred
  as not worth the churn until someone actually notices.
- Pause → Play resumes from the selected action's startTime, not the exact paused
  timestamp (official resumes from `max(selectedStart, lastPlayhead)`), which is
  imperceptible in practice given selection tracks the playhead.
