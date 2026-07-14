# 2026-07-14 — Trace viewer: timeline range selection (drag to select, play the section, scoped action list)

## What changed

The custom trace viewer's timeline now supports the official Playwright
viewer's range-selection behavior. Dragging on the timeline strip selects a
time window; while a selection is active:

- **Playback plays just that section.** Play starts from the selected action
  (or the window start when the selected action falls outside the window) and
  the playhead pauses when it reaches the selection's end instead of running
  to the end of the trace.
- **The action list scopes to the selection**, showing only actions that
  intersect the window (partial overlap counts, matching the official
  viewer's `selectedTime` predicate), with a "Timeline selection" bar at the
  top of the list whose **Show all** button clears the selection.
- **Stepping walks the selection-filtered playable set**, so prev/next never
  escape the window. (Strip click-seeks and hover captions use the unscoped
  set instead — see below.)
- **Console, Network, and Log filter to the window too.** Console rows and
  network requests (by request start time) outside the selection are hidden,
  the Console/Network tab-label counts narrow to match, and the Log tab shows
  only the active action's log entries inside the window. The crosshair
  (scope-to-selected-action) toggle composes on top: it further narrows
  within the selection. Each tab gets a selection-specific empty message.

A plain click on the strip seeks to that exact point — a press only becomes
a selection drag after ~4px of pointer travel — and, when a selection is
active, the click also dismisses it (on release). Click-seeks and hover
captions therefore always resolve against the FULL default-visible action
set (`seekActions`), never the selection-scoped one: the scoped set is for
playback and stepping only. This replaces the old drag behavior (continuous
scrubbing), which the hover preview card already covers better.

## Details

| Piece                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/trace-viewer/model.ts`               | New `TraceTimeRange` type + `actionIntersectsRange()` (the shared intersection predicate).                                                                                                                                                                                                                                                                                                                  |
| `components/playback-controls.tsx`        | `usePlayback` now takes `windowStartTime`/`windowEndTime` (the selection, or the whole trace) instead of `traceStartTime`; the controller exposes `playTo`; `Playhead` takes a `stopTime` at which the clock clamps, fires `onComplete`, and pauses. Playhead _positioning_ still maps over the full trace span, so it visibly pauses mid-strip at a selection end.                                         |
| `components/timeline.tsx`                 | Pointer handling split into click-seek vs. selection-drag (4px threshold, anchor latched on press); live `onSelectionChange` while dragging, `onSelectionChange(null)` on a dragless release while a selection is active; new `seekActions` prop (the unscoped set) for click-seeks + hover captions; selection rendered as a clear window with shrouded surroundings (`data-testid="timeline-selection"`). |
| `components/trace-viewer.tsx` (workbench) | Owns the `TraceTimeRange` state (model-keyed, render-time reset on attempt swap, same pattern as selection/hover); filters `playableActions` by the range; pauses playback whenever the range changes or clears.                                                                                                                                                                                            |
| `components/action-list.tsx`              | New optional `selection` + `onClearSelection` props; tree is built from the intersecting actions; "Timeline selection / Show all" scope bar under the filter input; selection-specific empty state.                                                                                                                                                                                                         |
| `components/detail-tabs.tsx`              | New optional `selection` prop threaded into `TraceTabProps` (plus a `timeInRange` helper in `model.ts`); Console/Network tab-label counts narrow to the window; the Log tab filters the active action's entries by `entry.time`.                                                                                                                                                                            |
| `components/console-tab.tsx`              | Rows filtered by `event.time` inside the window before the crosshair scoping/highlighting applies; selection-specific empty message.                                                                                                                                                                                                                                                                        |
| `components/network-tab.tsx`              | Entries filtered by `monotonicTime(entry)` (request start) inside the window before crosshair scoping; selection-specific empty message.                                                                                                                                                                                                                                                                    |

No schema, dependency, or config changes.

## Code notes

- The selection lives in the **workbench**, not the Timeline, because three
  siblings consume it (timeline strip, action list, playback controller) —
  same reasoning as the existing shared `usePlayback` controller.
- Selection state is stored with the model it belongs to and reset during
  render on attempt swap (a time range from another attempt is meaningless in
  the new trace's time base) — mirroring the existing `selection`/`hover`
  reset pattern in `Workbench`.
- Changing or clearing the window mid-play pauses playback rather than
  retargeting the running clock; the user re-hits Play on the new window.

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/trace-viewer-timeline.test.tsx src/__tests__/trace-viewer-action-list.test.tsx` — 49 passed. New coverage: drag creates/updates a selection (including right-to-left drags), sub-threshold clicks never create one, a click during an active selection seeks the FULL set and dismisses the window on release, playback inside a selection pauses at the window end and never selects out-of-window actions, the action list scopes to the window (partial overlap included), Show all clears it, and the scoped empty state renders.
- Console/Network/Log filtering: `trace-viewer-console-tab.test.tsx` (in-window rows only + selection-empty message), `trace-viewer-network-tab.test.tsx` (same, by request start time), `trace-viewer-detail-tabs.test.tsx` (Console/Network tab counts narrow to the window while Errors/Attachments stay whole-trace; Log tab shows only in-window entries + selection-empty message) — 92 passed across the six trace-viewer suites touched.
- `pnpm check` — 0 errors (140 pre-existing warnings).
- Full dashboard vitest run: the only failures are two pre-existing ones from a concurrent (uncommitted) tooltip refactor in `attachments-tab.tsx` / `snapshot-pane.tsx`, unrelated to this change — verified by stashing the working tree and re-running (they pass at HEAD, and this feature's suites pass with the refactor present).
