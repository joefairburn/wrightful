# 2026-07-11 — Trace viewer: in-place attempt switching (no more spinner)

## What changed

Switching attempts in the Replay dialog used to drop the whole viewer to a
full-screen "Loading trace…" spinner: the dialog remounted `<TraceViewer>` via
`key={activeDownloadHref}`, and even without that key `useTraceModel` reset to
`{status: "loading"}` the moment `traceUrl` changed. Now the switch is
**stale-while-loading**: the previous attempt's workbench (timeline, action
list, snapshot pane, detail tabs) stays fully rendered while the new trace
loads behind it in a second hidden bridge iframe, then the model swaps in
place. The only visible loading affordance during a switch is a thin progress
bar across the top of the viewer.

Nothing in the SW architecture forced the old behavior — the vendored
Playwright service worker caches parsed traces per trace URL and serves any
number of controlled bridge clients concurrently (the hover prewarm already
relied on this by pinning a prefetch iframe alongside the modal's own bridge).
The spinner was purely the React layer tearing down the workbench.

Also added: hovering a **non-selected** "Attempt N" segment in the dialog
header prewarms that attempt's trace (`warmTraceViewer(url)` — full load +
parse into the SW cache), so the actual switch on click is near-instant.

## How it works now

`useTraceModel` (`apps/dashboard/src/trace-viewer/use-trace-model.ts`):

- The `ready` state now carries `traceUrl` (the trace the READY model was
  parsed from) and `switching` (`{ progress } | null`, non-null while a
  different trace loads behind the current model). Consumers key the
  workbench on `state.traceUrl`, **not** the hook argument — during a switch
  they intentionally diverge.
- Two iframes coexist mid-switch: the **active** bridge (serves the visible
  model + fetch proxy, kept in a ref) and the **loading** bridge (owned by the
  per-`traceUrl` effect). When the new model arrives, the hook atomically
  retires the old iframe, rejects its in-flight proxied fetches ("Trace
  bridge unmounted." — they could never resolve), promotes the new iframe to
  fetch-proxy target, and publishes the new ready state.
- `fetchResult` handling moved to a persistent (mount-once) listener targeting
  the active iframe, because the per-trace effect's listener is already torn
  down while the previous bridge is still serving the visible workbench.
- First load and load-after-error keep the old behavior (full loading state,
  new iframe becomes the proxy target immediately). A load error or 30s
  timeout during a switch is still terminal — the user asked for that
  attempt, so the error replaces the stale workbench.
- Switching back to the already-active trace before the pending load finishes
  short-circuits: the pending iframe is discarded and the `switching` flag
  clears without reloading.

`TraceViewer` (`components/trace-viewer.tsx`) renders the workbench from
`state.traceUrl`/`state.contextEntries` inside a relative wrapper with a 2px
top progress bar while `state.switching` is set (determinate when the SW
reports progress, pulse otherwise), and marks the wrapper `aria-busy`.

`TestReplayContent` (`src/components/trace-viewer-dialog.tsx`) no longer keys
`<TraceViewer>` on the attempt, and the attempt `SegmentedControl` warms the
hovered non-selected attempt's trace. `SegmentedControl` gained an optional
`onOptionHover` prop (fires on `pointerenter` per option) to support this.

## Details

| File                                           | Change                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/trace-viewer/use-trace-model.ts`          | Stale-while-switching lifecycle; `ready` state gains `traceUrl` + `switching`; persistent fetchResult listener                                                                                    |
| `src/trace-viewer/components/trace-viewer.tsx` | Workbench keyed on the ready model's trace; thin switch progress bar                                                                                                                              |
| `src/components/trace-viewer-dialog.tsx`       | Dropped `key={activeDownloadHref}` remount; hover prewarm of non-selected attempts                                                                                                                |
| `src/components/segmented-control.tsx`         | New optional `onOptionHover` prop                                                                                                                                                                 |
| `src/__tests__/trace-viewer-hooks.test.tsx`    | Ready-shape updates + new "attempt switching" suite (7 tests: dual-iframe window, switch progress, in-place swap, switch error, switch-back cancel, mid-switch fetch routing, mid-switch unmount) |
| `src/__tests__/trace-viewer-dialog.test.tsx`   | Switch now asserts SAME viewer element (in-place update); new hover-prewarm test                                                                                                                  |

No schema, dependency, or config changes.

## Coverage follow-up (same day)

A coverage pass over `src/trace-viewer/**` showed three first-party files
with (near-)zero coverage — the `TraceViewer` shell itself (0%, mocked by the
dialog suite and its children tested individually), `split-pane.tsx` (0%),
and `escape-frames.ts` (2%). Three new suites close them:

| File                                               | Coverage                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/trace-viewer-shell.test.tsx`        | `TraceViewer` with `useTraceModel` mocked: spinner without/with progress, error surface via `describeTraceLoadError`, real `Workbench` over the shared fixture, switching bar (indeterminate + determinate + `aria-busy`), stale-model rendering while the prop points at the next trace. `trace-viewer.tsx` 0% → 100% (all metrics). |
| `src/__tests__/trace-viewer-split-pane.test.tsx`   | Initial fraction/flex-basis, separator `aria-orientation`, horizontal + vertical drag math against the stubbed 800×400 rect, min/max clamping, no-op moves without a drag, `lostpointercapture` ending the drag. 0% → 100% lines.                                                                                                     |
| `src/__tests__/trace-viewer-escape-frames.test.ts` | `bindEscapeAcrossFrames` against real happy-dom frames: top-window Escape, non-Escape ignored, pre-existing + nested frames, MutationObserver re-scan for late frames, no listener stacking on re-scan, full cleanup, cross-origin (throwing `document` getter) guard. 2% → 97% lines.                                                |

Both progress bars in `trace-viewer.tsx` also gained `role="progressbar"` +
`aria-value*`/`aria-label` (the switching bar omits `aria-valuenow` while
indeterminate) — an a11y improvement that doubles as the test handle.

Remaining known gaps, deliberate: `vendor/` (~61% — vendored Playwright code,
guarded by the vendor-sync/protocol suites rather than line coverage) and the
odd unreachable defensive branch (e.g. `use-trace-model`'s protocol-skew
`default:` arm). Scoped totals for `src/trace-viewer/**` + the dialog +
segmented control: 85% statements / 88% lines.

## Snapshot iframe flash fix (same day)

The one residual flash — the snapshot pane's iframe going blank at the swap
moment while the new attempt's DOM snapshot rendered — is gone too. Two
changes:

- **The workbench is no longer keyed on the trace.** `TraceViewer` renders a
  single `Workbench` instance across attempt swaps; the workbench stores its
  selection _with_ the model it belongs to and replaces a stale `callId`
  during render (a render-time state adjustment, not an effect — an effect
  would let one frame render the old selection against the new model and
  flash the pane's empty state). Side effect: split-pane sizes, the detail
  tab, and the snapshot tab now all SURVIVE attempt switches.
- **`BufferedSnapshotFrame` double-buffers each tab slot.** When a slot's
  snapshot URL changes (scrubbing to another action, an attempt swap, or the
  canvas-from-screenshot toggle), the previous document stays visible while
  the next loads in a hidden sibling iframe; on `load` the new frame is
  promoted in place (frames are keyed by URL, so promotion reuses the
  already-loaded element and the retired front unmounts, running its
  escape-binding cleanup). A target that changes again mid-load replaces the
  hidden buffer; a target that returns to the visible document just drops
  it. This also makes ACTION scrubbing flash-free, which previously reloaded
  the visible iframe.
- `useSnapshotInfo`'s sidecar cache is now keyed by trace URL as well —
  page ids / snapshot names recur across attempts with different content,
  and the cache now outlives a swap since the pane stays mounted.

Tests: two new `SnapshotPane` tests (buffer window + promote-on-load;
swap-back mid-load drops the buffer), one new shell test (selection resets to
the new model's default on an in-place model swap, scoped to the action
list's `aria-selected` option), and the canvas-toggle test now settles the
pending buffered loads before asserting.

## Verification

- `pnpm --filter @wrightful/dashboard test` — all passing (both vitest lanes;
  includes the 9 new/updated switch tests, the 20 coverage tests, and the 3
  buffering/selection tests — trace-viewer total now 20 files, 155 tests).
- `pnpm check` — exit 0 (format + lint + typecheck).
- Remaining visual note: at the promotion instant the pane cuts directly
  from the old attempt's snapshot to the new one (no blank in between).
  Screencast thumbnails in the timeline still repopulate as their blobs
  fetch; not perceived as a flash.
