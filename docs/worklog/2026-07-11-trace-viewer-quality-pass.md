# 2026-07-11 — Trace viewer code-quality pass (post-review restructure)

## What changed

A deep code-quality review of the `custom-trace-viewer` branch (strict
structural review: abstractions, duplication, dead mechanisms, boundary
cleanliness) produced a set of verified findings; this entry records the
behavior-preserving restructure that implemented them. No user-visible
behavior changed except two deliberate micro-fixes called out below.

### Structural

- **`timeline.tsx` split (645 → ~485 lines) + playback engine extracted to
  `playback-controls.tsx`.** The playback half (speeds, rAF clock,
  play/pause/stop/step, control cluster) only ever touched the strip through
  `playableActions` / `selectedCallId` / `onSelect`, so it now lives behind a
  `usePlayback` hook + `PlaybackControls` component. The playback state model
  collapsed from five variables (`playing`, `playheadTime`, `playheadRef`,
  `lastSelectedRef`, derived fraction) to `playing` + a per-session
  `Playhead` child: the moving playhead line owns its own rAF loop and
  positions itself by mutating `style.left` on its own ref, so **the Timeline
  no longer re-renders 60×/sec during replay** (previously every frame
  re-rendered the filmstrip, bars lane, and controls). Speed changes read
  through a ref, so they take effect mid-flight without restarting the loop.
  Three hand-rolled sorted-array searches (`nearestFrameIndex`,
  `nearestActionIndex`, `actionActiveAt`) now share one `lowerBoundByTime`
  primitive; `TraceFrameImage` de-duplicates the filmstrip thumb / hover
  preview image box; hover state folded into one `{ fraction, below } | null`.

- **Shared detail-tab primitives (`detail-shared.tsx`).** `Field`, `Section`,
  `GeneralRow`, `TabNotice`, and `ScopedEmpty` replace the copy-pasted
  micro-label markup that appeared 5× across call/metadata/network tabs, the
  5× muted inline notice, and the console/network dual empty state. The
  time-window predicates in console-tab (start→next-action-start) vs
  network-tab (start→end on `_monotonicTime`) are intentionally NOT unified —
  only the wrapper is shared. Deliberately thin: no "tab shell" abstraction.

- **Dead reset mechanisms deleted.** `Workbench` already remounts per trace
  via `key={traceUrl}`, so the `useEffect(..., [model])` resets in
  detail-tabs and network-tab (including the "close panel when filtered out"
  effect, which was also redundant with the derived `entries.find(...)`)
  are gone. The one real risk — a stray second terminal bridge message — is
  now guarded once at the source (`use-trace-model.ts` ignores a second
  `model`/`error` message).

- **`SnapshotFrame` extraction.** The snapshot stage's manually keyed
  `Map<string, cleanup>` of escape-bindings (which leaked a dead closure per
  scrubbed-past action) is gone; each iframe is its own `SnapshotFrame`
  component owning one cleanup ref, released on unmount/rebind — React's
  keyed unmounting does the bookkeeping.

- **`MultiTraceModel` compat alias removed.** App code now uses the upstream
  name `TraceModel` directly; the alias export was deleted from
  `vendor/model-util.ts`, which let `sync-trace-vendor.mjs` drop its most
  brittle transform (`insertAfterClassClose` + `aliasClassName` machinery,
  ~60 lines). Vendor files are now assembled as pure header + rewritten body
  - declared patches, no structural insertion.

### Boundary / correctness-adjacent

- **`escape-frames.ts`**: the rebinding guard was keyed on `Window`, but
  `contentWindow` is a stable WindowProxy while listeners land on the
  per-navigation inner document — nested frames that re-navigated within one
  snapshot silently lost Escape handling. Now keyed on `Document`.
- **`SnapshotInfo` is a discriminated union** (`{error} | {url, viewport, …}`)
  with an exported `parseSnapshotInfo(raw: unknown)` validator replacing the
  unsound `raw as SnapshotInfo` cast on bridge JSON.
- **Network body preview split `isTextLike` → `isText` + size cap**
  (deliberate micro-fix): small binary bodies (woff2/wasm/zip) are no longer
  fetched and rendered as mojibake, and an oversized text body now falls into
  the "Preview not available · N KB" branch instead of an uncapped fetch.
  Regression test added (binary body ⇒ no bridge fetch).
- **Action list**: selected-row `scrollIntoView` moved from an inline ref
  callback (fired on every render — yanked the list on every filter
  keystroke) to an effect keyed on selection. `ActionRow` now calls the
  module-level `actionParamHint` instead of re-implementing it (search text
  and rendered hint can no longer diverge). XOR collapse predicate extracted
  to a pure `isEffectivelyCollapsed` used by both consumers.
- **Replay dialog contract**: `TestReplayContent` now takes a required,
  non-empty `attempts` array (the artifacts rail passes a one-element array)
  — the previous three-sources-of-truth prop shape (top-level
  `viewerUrl`/`downloadHref` + optional attempts + fallback chains) is gone.
  The `/replay` route response shape is unchanged (e2e contract); its
  `as (typeof attempts)[number]` cast was replaced by an explicit guard.
- **Canonical helpers adopted**: network durations through `formatDuration`,
  LogTab offsets through `formatTraceOffset` (Log and Console now render the
  same instant identically), `isConsoleRow` exported from console-tab and
  reused for the tab badge, HAR underscore-extension access centralized in
  `har-fields.ts` (kills 4 copies of the lint-workaround comment), call-tab's
  Return-value block reuses `renderJsonValue`, attachments-tab's pure base64
  decode moved from an effect+sentinel to `useMemo`.
- **New shared hooks**: `use-element-size.ts` (two divergent ResizeObserver
  idioms unified) and `use-persisted-flag.ts` (localStorage boolean, same
  `"1"`/`"0"` format so persisted values carry over).

### Vendoring machinery hardened

- `sync-trace-vendor.mjs`: unmapped **relative** imports and side-effect
  imports in a rewritten vendor body now fail loudly (previously silent);
  `splitAtFirstCodeLine` fails on an empty body or non-comment discarded
  prefix; `bumpVersionMentions` is word-bounded `v<old>` → `v<new>` (catches
  "As of v1.61.1" prose, not just `tag vX.Y.Z`); `--pr` now stops after
  commit and prints the push/PR commands instead of half-running them.
- The triplicated playwright-core resolution dance now lives once in
  `scripts/lib/playwright-core.mjs` (+ hand-written `.d.mts`, following the
  `probe-status.d.mts` pattern), shared by both scripts and the version
  canary test.

### Tests

- The ~250 duplicated lines of happy-dom stub scaffolding (ResizeObserver,
  rect/clientSize mocks, objectURL, scrollIntoView/pointer-capture/
  getAnimations polyfills) across three suites — plus four other suites'
  no-restore module-scope variants — are now one
  `trace-viewer-test-env.ts` / `installTraceViewerDomStubs(options)` helper
  with a restore function.
- `trace-viewer-model.test.ts` rewritten onto the shared fixture
  (`makeContext`/`makeAction`/`FIXTURE_TRACE_URL`) and the `vite-plus/test`
  runner import (was the one file on bare `vitest`).
- The arbitrary `tabs-a`/`tabs-b` split (criterion: "needs heavy DOM stubs")
  is replaced by per-component files: `trace-viewer-{call,errors,metadata,
console,network,attachments}-tab.test.tsx`.
- The timeline suite no longer asserts on Tailwind utility classes
  (`.rounded-sm`, `.cursor-crosshair`, `.shadow-md`, `className.includes
("bg-fail")`); the markup gained `data-testid` (`timeline-strip`,
  `timeline-bar`, `timeline-playhead`, `timeline-preview`) and
  `data-status`/`data-selected` attributes that the tests target instead.

## Details

| Item          | Value                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New modules   | `trace-viewer/components/detail-shared.tsx`, `trace-viewer/components/playback-controls.tsx`, `trace-viewer/har-fields.ts`, `trace-viewer/use-element-size.ts`, `trace-viewer/use-persisted-flag.ts`, `scripts/lib/playwright-core.mjs` (+ `.d.mts`), `src/__tests__/trace-viewer-test-env.ts` |
| Deleted files | `src/__tests__/trace-viewer-tabs-a.test.tsx`, `trace-viewer-tabs-b.test.tsx` (split per component)                                                                                                                                                                                             |
| Renames       | `MultiTraceModel` → `TraceModel` (app + tests; vendor alias deleted)                                                                                                                                                                                                                           |
| Dependencies  | none added/removed                                                                                                                                                                                                                                                                             |
| Schema/API    | none — `/replay` response shape unchanged                                                                                                                                                                                                                                                      |

## Verification

- `pnpm check` — **0 errors**, 131 warnings (baseline before this pass: 133 —
  two pre-existing warnings were removed, none added; the only warning in a
  touched file, `use-trace-model.ts:116`, predates this pass).
- `pnpm test` — dashboard **1222/1222** + reporter **291/291** passed.
- Trace-viewer suites specifically: **118 tests / 16 files**, identical count
  before and after the test restructure (nothing dropped).
- `node scripts/sync-trace-vendor.mjs --dry-run` — all 7 managed vendor files
  round-trip **byte-identical** at the v1.61.1 pin after the alias removal;
  `node scripts/vendor-trace-viewer.mjs` exits 0.
- E2E: `node scripts/run-dashboard-e2e.mjs test-replay.spec.ts` (real trace
  through the real service worker — action list populated, SW-served snapshot
  iframes, search box / Call tab / timeline chrome, deep-link, Escape) —
  **3/3 passed** against a local Postgres. A full-suite e2e run also passed
  all replay tests; its two failures (monitors, navigation) were `page.goto`
  timeouts in specs untouched by this pass, consistent with resource
  contention in the sandbox environment.
