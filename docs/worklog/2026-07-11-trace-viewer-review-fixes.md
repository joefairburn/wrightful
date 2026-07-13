# 2026-07-11 — Trace viewer: second review pass, findings addressed

## What changed

A second strict code-quality review of the `custom-trace-viewer` branch (after
the same-day quality pass) produced six major and ~20 minor verified findings;
this entry records the behavior-preserving fixes. Two user-visible micro-fixes
are called out inline; everything else is structural.

### Majors

- **One `useBridgeFetch` hook replaces four copies of the bridge-fetch-into-state
  idiom** (`use-bridge-fetch.ts`, with a `useBridgeText` specialization).
  `use-object-url.ts` had established the correct keyed-result shape; the
  copies in source-tab, network-tab (`ResponseBodyPreview`), and
  attachments-tab had drifted — the first two could render one frame of the
  PREVIOUS file/entry's text under the new key (visible flash + mismatched
  tokenization/scroll target in Source). All three now share the hook; the
  stale-frame gap is closed by construction. Source-tab's two
  adjust-state-in-effect resets are gone — `DetailTabs` keys `SourceTab` on
  the selected action's `callId` instead.
- **Playback engine: `handleComplete` collapsed into a stable `pause`, and
  `Playhead` now really reads its callbacks through refs.** The old comment
  claimed `onSelect`/`onComplete` "fire through refs"; they were effect deps,
  so every parent re-render (each action crossing, every `pointermove` over
  the strip) cancelled and restarted the rAF loop, dropping a baseline frame —
  moving the mouse over the strip during replay visibly stalled the playhead.
  `pause` is a `useCallback` (it was also byte-identical to `handleComplete` —
  two names for one behavior), and the rAF effect's deps no longer include
  callback identities. The callback refs are assigned in a post-commit effect
  (matching the adjacent `speedRef`), never during render, so an abandoned
  concurrent render can't leave its callbacks behind.
- **`warm.ts` no longer accumulates trace-pinning iframes.** Each full-prefetch
  iframe pins a parsed trace in the SW for the life of the (client-side
  navigated) session, and the dedupe key included the signed token — a re-mint
  re-pinned the same trace. Now: at most ONE prefetch iframe (previous one
  removed on replace), deduped on `origin+pathname`. Register-only warm stays
  a one-shot boolean.
- **`use-trace-model.ts` message handling is an exhaustive `switch`.**
  Previously an unknown bridge method (realistic protocol skew — `bridge.html`
  is a separately served asset and the protocol already grew once) fell into
  the terminal `else` and produced `{ status: "error", error: undefined }`,
  which crashed `describeTraceLoadError` (`.includes` on undefined). Unknown
  methods are now ignored; `model`/`error` are the only terminal cases.
- **Vendor drift is now caught offline.** `sync-trace-vendor.mjs` writes
  `vendor/vendor-manifest.json` (sha256 of each of the 7 machine-managed
  files' exact bytes; new `--manifest-only` flag regenerates offline), and
  `trace-viewer-vendor.test.ts` gained a drift canary that hashes the on-disk
  files against it — a hand-edit that bypasses `bodyPatches` now fails the
  suite with a runbook message instead of being silently clobbered by the next
  sync. (Negative-tested: a one-byte change to `har.ts` fails with the
  intended message.) `version.ts` + the version-canary message now prescribe
  `sync:trace-vendor` instead of the pre-script manual procedure.
- **The Replay dialog surface finally has tests**
  (`trace-viewer-dialog.test.tsx`, 5 tests): switcher hidden for one attempt /
  shown for retries, defaults to the LAST attempt, switching remounts the
  viewer on the new trace URL (element-identity assertion), the
  `ReplayModalHost` failure path clears `?replay=`, and the no-viewer-URL
  artifact renders nothing.

### Boundary / contract minors

- **`/replay` route**: query now `asc(artifacts.attempt)` — the desc→copy→
  re-sort dance and its hand-written "unreachable" throw are gone (one
  `rows.length === 0` guard). The redundant top-level
  `traceViewerUrl`/`downloadHref` (self-described as "e2e/back-compat", but
  the client and route deploy together and only the e2e spec read them) are
  **dropped from `TestReplayResponse`**; the e2e assertion now reads
  `attempts.at(-1)`.
- **Dialog**: `TestReplayAttempt.viewerUrl` renamed to `traceViewerUrl` so it
  matches the route shape — `ReplayModalHost` passes `body.attempts` straight
  through (the field-by-field rename mapping is deleted).
  `onTriggerPointerEnter` is gone; the dialog's own trigger performs the
  full-prefetch warm (the rail's callback used only props the dialog already
  owns, plus a dead `typeof window` guard inside a pointer handler).
- **SnapshotPane**: `bridge` is required (matching `TraceTabProps`; the only
  caller always passed it) — the phantom-optional branches (`bridge ? <UrlBar>`
  and the `!bridge` bail in `useSnapshotInfo`) are deleted. `popoutHref`'s
  dead `typeof window === "undefined"` guard + misleading "null on SSR"
  comment removed (the pane only ever mounts after a client-side bridge
  message).
- **console-tab**: `actionEvents?.has(event)` under an already-established
  invariant → `scoped` is now an aliased condition TS narrows through; the
  mode split reads as two total branches.
- **split-pane**: manual `addEventListener` bookkeeping (which leaked the
  `pointermove` listener on `pointercancel`, leaving hover-resize live)
  replaced by plain React handlers gated on a dragging ref, ended by
  `onLostPointerCapture` (fires for both up and cancel).

### Canonical-helper minors

- `trace-viewer/format.ts` gained `formatTraceDuration` (rounds fractional
  monotonic ms once — **fixes metadata-tab rendering `834.5999…ms`** for
  sub-second traces, the one place that forgot to round; call-tab and both
  network call sites migrated) and `prettyPrintJson` (replaces the two private
  copies in network-tab / attachments-tab).
- New `src/components/ansi-pre.tsx` (`AnsiPre`): owns the single
  `dangerouslySetInnerHTML` + lint-suppression for ANSI blocks; the four
  copies in call-tab, errors-tab, artifacts-rail (`RailLogBlock`), and
  test-error-alert (stack `<pre>`; the inline title `<span>` stays) migrated.
- New `trace-viewer/bridge-iframe.ts` (`BRIDGE_PATH` + `mountBridgeIframe`):
  the five-line hidden-iframe ritual and the bridge path string existed twice
  (`warm.ts` re-inlined the path); both call sites are one line now.
- `ResponseBodyPreview` takes a required `sha1` (caller already gated on it);
  its unreachable `!sha1` fallback deleted. The crosshair scope toggle
  (detail-tabs) and canvas-from-screenshot toggle (snapshot-pane) are
  `ui/button` ghost `icon-xs` buttons instead of hand-rolled `<button>`s.
- Test hooks for styling-independent assertions: timeline preview card
  `data-side="top|bottom"`, action-list rows and the network status cell
  `data-status="fail|ok"`.

### Vendoring machinery minors

- Fail-loud dynamic-`import()` guard (mirroring the side-effect-import guard);
  `IMPORT_FROM_RE`'s string-literal exposure documented.
- `applyBodyPatches`: exactly-one-occurrence enforcement (a second upstream
  occurrence of a patch's `find` now fails the sync instead of shipping
  unpatched) + function replacement so `$` sequences stay literal.
- A header-prose consistency check (`assertHeaderDocumentsImportMap` — every
  importMap specifier must appear in the retained vendor header) was
  implemented and then deliberately REMOVED on review: it enforced
  documentation wording, not correctness, and its false-positive cost lands
  exactly at sync time. The dual-maintenance convention stays as the comment
  on `VERBATIM_FILES`; the manifest canary is the guard that matters.
- Shared `resolvePlaywrightCoreOrExit(importMetaUrl, label)` in
  `scripts/lib/playwright-core.mjs` (+ `.d.mts`) replaces the byte-identical
  try/catch wrappers in both scripts; `vendor-trace-viewer.mjs` stops
  re-parsing `package.json` for the version the resolver already returns.

### Tests

- `makeTabProps(overrides?)` added to `trace-viewer-fixture.ts`; the six
  copy-pasted `baseProps` blocks (two divergent shapes) across the tab suites
  are gone. `makeAction` takes `Partial<Action>` (single cast on the merged
  result) instead of `Record<string, unknown>`.
- The triplicated 9-line happy-dom rationale comment lives once in
  `trace-viewer-test-env.ts`; call sites carry a two-line pointer.
- Surviving Tailwind-class assertions (preview `top-full`/`bottom-full`,
  `svg.text-fail`, network `text-fail`) replaced with the new data attributes.
- hooks suite: shared `captureRequestId` helper; the fake-timers test restores
  real timers in `finally` (a failing expect no longer leaks fake timers into
  later tests).
- `trace-viewer-warm.test.ts` rewritten for the new single-slot semantics
  (token-rotation dedupe; replacement removes the previous iframe).
- `trace-viewer-vendor.test.ts` onto `vite-plus/test` (last suite on bare
  `vitest`) + the new drift canary.

## Details

| Item         | Value                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New modules  | `trace-viewer/use-bridge-fetch.ts`, `trace-viewer/bridge-iframe.ts`, `components/ansi-pre.tsx`, `trace-viewer/vendor/vendor-manifest.json` (generated), `__tests__/trace-viewer-dialog.test.tsx` |
| Removed API  | `TestReplayResponse.traceViewerUrl` / `.downloadHref` (top-level); `TraceViewerDialog.onTriggerPointerEnter`; `usePlayback().handleComplete` (use `pause`)                                       |
| Renames      | `TestReplayAttempt.viewerUrl` → `traceViewerUrl`                                                                                                                                                 |
| Dependencies | none added/removed                                                                                                                                                                               |
| Schema       | none                                                                                                                                                                                             |

## Verification

- `pnpm check` — **0 errors, 131 warnings** (exact pre-pass baseline; the
  prior worklog's formatting failure fixed via `vp check --fix`, and the four
  `no-shadow` warnings the new hook briefly introduced were resolved by
  simplifying its `load` signature to close over the stable `bridge`).
- `pnpm test` — dashboard **1222/1222** (unit lane 404 passed / 4 skipped,
  44 files + 1 pre-existing pg-integration skip — includes the new dialog (5)
  and vendor drift-canary suites) + reporter **291/291**.
- `node scripts/vendor-trace-viewer.mjs` — exit 0; all 7 managed vendor bodies
  byte-unchanged (`git diff` clean except `version.ts` docstring); drift
  canary negative-tested (one-byte change to `har.ts` fails with the intended
  runbook message, restored byte-identical).
- `pnpm exec tsgo --noEmit` — exit 0.
- E2E: `node scripts/run-dashboard-e2e.mjs test-replay.spec.ts` (real trace
  through the real service worker, against local Postgres) — **3/3 passed**,
  including the updated `attempts.at(-1)` contract assertion.
