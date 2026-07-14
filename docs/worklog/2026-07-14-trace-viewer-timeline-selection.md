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
- **Stepping, strip seeks, and hover captions** all walk the same
  selection-filtered playable set, so prev/next never escape the window.

A plain click on the strip still seeks exactly as before — a press only
becomes a selection drag after ~4px of pointer travel. This replaces the old
drag behavior (continuous scrubbing), which the hover preview card already
covers better.

## Details

| Piece                                     | Change                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/trace-viewer/model.ts`               | New `TraceTimeRange` type + `actionIntersectsRange()` (the shared intersection predicate).                                                                                                                                                                                                                                                                          |
| `components/playback-controls.tsx`        | `usePlayback` now takes `windowStartTime`/`windowEndTime` (the selection, or the whole trace) instead of `traceStartTime`; the controller exposes `playTo`; `Playhead` takes a `stopTime` at which the clock clamps, fires `onComplete`, and pauses. Playhead _positioning_ still maps over the full trace span, so it visibly pauses mid-strip at a selection end. |
| `components/timeline.tsx`                 | Pointer handling split into click-seek vs. selection-drag (4px threshold, anchor latched on press); live `onSelectionChange` while dragging; selection rendered as a clear window with shrouded surroundings (`data-testid="timeline-selection"`).                                                                                                                  |
| `components/trace-viewer.tsx` (workbench) | Owns the `TraceTimeRange` state (model-keyed, render-time reset on attempt swap, same pattern as selection/hover); filters `playableActions` by the range; pauses playback whenever the range changes or clears.                                                                                                                                                    |
| `components/action-list.tsx`              | New optional `selection` + `onClearSelection` props; tree is built from the intersecting actions; "Timeline selection / Show all" scope bar under the filter input; selection-specific empty state.                                                                                                                                                                 |

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

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/trace-viewer-timeline.test.tsx src/__tests__/trace-viewer-action-list.test.tsx` — 48 passed. New coverage: drag creates/updates a selection (including right-to-left drags), sub-threshold clicks never create one, playback inside a selection pauses at the window end and never selects out-of-window actions, the action list scopes to the window (partial overlap included), Show all clears it, and the scoped empty state renders.
- `pnpm check` — 0 errors (140 pre-existing warnings).
- Full dashboard vitest run: the only failures are two pre-existing ones from a concurrent (uncommitted) tooltip refactor in `attachments-tab.tsx` / `snapshot-pane.tsx`, unrelated to this change — verified by stashing the working tree and re-running (they pass at HEAD, and this feature's suites pass with the refactor present).
