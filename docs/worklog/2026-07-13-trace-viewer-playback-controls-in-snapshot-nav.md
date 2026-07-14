# 2026-07-13 — Trace viewer: move playback controls into the snapshot nav

## What changed

The trace viewer's playback control cluster (prev / play–pause / stop / next /
speed) moved out of the timeline strip and into the snapshot pane's
Before/Action/After nav bar, sitting on the right side just before the
paint-`<canvas>` toggle (separated from it by a hairline divider). The timeline
strip now spans the full width of its row.

Functionally nothing about playback changed — the same `usePlayback` engine, rAF
`Playhead`, and stepping/seek semantics — only where the buttons render.

## Why / how

The control cluster and the timeline's moving `Playhead` are driven by one
`usePlayback` controller, but they now live in **sibling** components
(`SnapshotPane` and `Timeline`). So the controller was lifted one level up into
`Workbench` (`trace-viewer.tsx`) and shared with both:

- `Workbench` now owns `usePlayback`, the `playableActions` memo
  (`model.filteredActions([])`, the default-visible set playback + seeking
  walk), and the attempt-swap "pause on new model" effect — all previously
  internal to `Timeline`.
- `Timeline` takes `playback: PlaybackController` and `playableActions` as
  props. It still draws the strip, action-bars lane, hover preview, click/drag
  seek, and the `Playhead`; it no longer renders `PlaybackControls`.
- `SnapshotPane` takes `playback` + `playableActionsCount` and renders
  `<PlaybackControls>` in its nav's right cluster, before the paint button.
- `PlaybackControls` lost its timeline-specific `border-r`/padding wrapper (it's
  now an inline cluster in the nav).

### Follow-up: keep the nav row height constant

The nav's height came from the `TabBarTab` boxes, so an action that captured no
snapshot (empty Before/Action/After set) collapsed the row to the shorter
control cluster on the right. Fixed by rendering an invisible, `aria-hidden`
placeholder with the same `px-3 py-2 text-body` box as a tab when there are no
tabs — reserving exactly one tab's height and leaving the populated state
pixel-identical.

### Follow-up: remove the paint-`<canvas>` toggle

The paint-`<canvas>`-from-screenshot toggle (the `ImageIcon` button that sat
between the playback cluster and the popout link) was removed as unhelpful — the
repaint was best-effort and imprecise. This let its whole plumbing go: the
`canvasFromScreenshot` state, the `usePersistedFlag` hook (now deleted — it had
no other consumer), the `CANVAS_FROM_SCREENSHOT_KEY` localStorage key, and the
`populateCanvasFromScreenshot` option on `snapshotIframeUrl` (`model.ts`). The
divider now sits before the popout link (only rendered when a popout exists).

### Follow-up: full-width header divider

The rule under the Before/Action/After row was the `TabBar`'s own `border-b`,
which spans only the `flex-1` TabBar and so stopped where the playback/popout
controls begin. Moved the divider onto the whole header row (`border-b` on the
row) and dropped the TabBar's rule (`border-b-0`) so a single 1px line spans the
full width; the active-tab underline still overhangs it (geometry unchanged).

### Follow-up: align the left/right pane header dividers

The action-list filter header (`h-8` boxed input + `py-1.5` ≈ 45px) was taller
than the snapshot pane's Before/Action/After nav (tabs ≈ 36px), so the two
panes' bottom dividers didn't line up across the split. Reworked the filter
field into the borderless, full-width command-menu style (the same as
`ComboboxFilterPopup`'s search row): the `<input>` itself IS the pane's top edge
(`h-9 w-full bg-transparent`, no box), and the wrapper carries the hairline
divider. That `h-9` matches the snapshot nav, so both dividers align — and the
boxed input border is gone. Dropped the `SearchFilterInput` (magnifier box) from
this pane; kept `type="search"` for the searchbox role.

### Follow-up: icon actions in the Replay dialog header

The Replay dialog (`trace-viewer-dialog.tsx`) header had three text buttons:
"Official viewer" (self-hosted official viewer), "Download", and "Public viewer"
(trace.playwright.dev). Dropped "Official viewer" — the public viewer is the
same viewer for the user's purposes — and turned the remaining two into
icon-only buttons with hover tooltips: a `Share2` icon opening the public
Playwright viewer, and a `Download` icon. The `traceViewerUrl` field stays on
the wire contract (still used as `TraceViewerDialog`'s availability gate) but is
no longer surfaced as a link.

## Files

| File                                            | Change                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/trace-viewer.tsx`                   | Lifted `usePlayback` + `playableActions` + attempt-swap pause into `Workbench`; threads `playback`/`playableActions` to `Timeline` and `playback`/`playableActionsCount` to `SnapshotPane`. |
| `components/timeline.tsx`                       | Dropped internal `usePlayback`, `playableActions` memo, swap effect, and the `PlaybackControls` render; added `playback`/`playableActions` props.                                           |
| `components/snapshot-pane.tsx`                  | Added `playback`/`playableActionsCount` props; renders `PlaybackControls` in the nav's right cluster. Removed the paint-`<canvas>` toggle button + its state/plumbing.                      |
| `components/playback-controls.tsx`              | Removed the strip-specific `border-r border-line-1 px-1.5` wrapper on the cluster.                                                                                                          |
| `trace-viewer/model.ts`                         | Dropped the now-unused `populateCanvasFromScreenshot` option from `snapshotIframeUrl`.                                                                                                      |
| `trace-viewer/use-persisted-flag.ts`            | Deleted — no remaining consumer after the canvas toggle was removed.                                                                                                                        |
| `__tests__/trace-viewer-timeline.test.tsx`      | Added a `Harness` that reproduces the workbench wiring (one `usePlayback` shared by `PlaybackControls` + `Timeline`); toolbar/seek/play-through tests now render through it.                |
| `__tests__/trace-viewer-snapshot-pane.test.tsx` | Threaded a no-op `STUB_PLAYBACK` controller + `playableActionsCount` through every render site.                                                                                             |

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run` on the timeline, snapshot-pane, and model trace-viewer suites → **32 passed** (the `NetworkError` console noise is the pre-existing snapshot-iframe fetch stubbing, not a failure).
- `tsgo --noEmit` → exit 0, no errors.
- `pnpm check` → clean apart from a pre-existing formatting issue in an unrelated staged worklog doc (`docs/worklog/2026-07-10-custom-trace-viewer-consolidated.md`).
