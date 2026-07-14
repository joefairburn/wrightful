# 2026-07-14 — Trace viewer: thermo-nuclear code-quality review fixes

A strict maintainability pass over the custom trace-viewer branch, driven by a
`/thermo-nuclear-code-quality-review`. One correctness/security blocker, a set
of "code-judo" simplifications that delete duplicated machinery, a house-
convention fix, and several targeted dedups. All behavior-preserving except the
blocker (which restores a lost security cap) and the react-query restore (which
undoes a regression).

## BLOCKER — artifact-serving policy re-consolidated (security)

The `/api/artifacts/:id/download` route had re-inlined the direct-R2/302 fork
that `serveArtifactBytes` (`src/lib/artifacts/serve.ts`) is meant to own,
orphaning the helper (zero production callers) and **diverging on the presign
TTL cap**: the live route capped the presigned R2 URL to
`min(remainingTokenSeconds, ARTIFACT_TOKEN_TTL_SECONDS)` (1h), while the
orphaned helper — still exercised by `artifact-origin-safety.workers.test.ts`,
the "single policy" test — capped only to the token's remaining life (8h for
trace tokens). Anyone "restoring the canonical path" would silently reintroduce
an 8h anonymous-read R2 URL.

Fix: moved the `min(…, ARTIFACT_TOKEN_TTL_SECONDS)` cap **into**
`serveArtifactBytes` (the presign cap now lives with the policy it protects),
reverted `routes/api/artifacts/[id]/download.ts` to auth + translation only
(delegating to the helper), and re-pointed the docs. The download-route test's
docstring ("through the real `serveArtifactBytes`") is true again. Also restored
the oklch design-token colors in the expired-artifact HTML (they'd been
hardcoded to hex on the branch).

## Code-judo simplifications

| Change                                                                                                                                                                                                                                                                                                                                                                                                    | Files                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **`useModelScopedState`** — the "state stored WITH the model + render-phase reset" idiom was copy-pasted 4× (workbench selection/hover/timeRange + action-list overrides). Extracted one documented hook (stable setter, `SetStateAction` support) and wired all four sites.                                                                                                                              | `use-model-scoped-state.ts` (new), `trace-viewer.tsx`, `action-list.tsx`                                       |
| **Shared sha1 body preview** — `network-tab`'s `ResponseBodyPreview` and `attachments-tab`'s preview independently resolved bytes-by-sha1 → image/text with a state ladder (already drifted: `break-words`/`break-all`, differing caps). Extracted `BridgeBodyPreview`; network is now a one-liner.                                                                                                       | `components/body-preview.tsx` (new), `network-tab.tsx`, `attachments-tab.tsx`                                  |
| **MIME classifiers** — 3–4 disagreeing `includes`/`startsWith` ladders ("is text / is image / base type") centralized.                                                                                                                                                                                                                                                                                    | `mime.ts` (new) — `baseMimeType`/`isImageMime`/`isTextMime`                                                    |
| **`useBridgeFetch` reuse** — `useSnapshotInfo` rebuilt on the canonical primitive (dropped its bespoke cancelled-flag + keyed-state; kept a small per-hook cache for the no-flicker re-select). `useObjectUrl`'s `keepPrevious` boolean un-forked into two linear hooks `useObjectUrl` / `useBufferedObjectUrl`; `TraceFrameImage` split into a presentational `FrameImageBox` + plain/buffered wrappers. | `use-object-url.ts`, `snapshot-pane.tsx`, `timeline.tsx`                                                       |
| **`timeScale` value object** — the strip's model-time ↔ fraction ↔ percent maps were open-coded ~15× (some clamped, some not, some as `%` strings). One `makeTimeScale()` now owns `timeAt`/`fractionAt({clamp})`/`percentAt`; every call site routes through it and `clampFraction` disappears.                                                                                                          | `timeline.tsx`                                                                                                 |
| **Shared window selectors** — `DetailTabs` recomputed the Console/Network tab-label counts with the same predicate the tab bodies use. `selectConsoleRows` / `selectNetworkEntries` are now the single source for both count and body.                                                                                                                                                                    | `console-tab.tsx`, `network-tab.tsx`, `detail-tabs.tsx`                                                        |
| **`basename`** — the "last path segment" idiom, hand-rolled with differing separators/fallbacks, centralized (`/` + `\`). Wired source/console tabs + the run list.                                                                                                                                                                                                                                       | `lib/basename.ts` (new), `source-tab.tsx`, `console-tab.tsx`, `group-tests-by-file.ts`, `run-progress-row.tsx` |
| **`isWithinSelectedAction` → `timeInRange`** — network's bespoke range predicate collapsed onto the shared one via a single `actionRange`.                                                                                                                                                                                                                                                                | `network-tab.tsx`                                                                                              |
| **`actionsCount` → `atStart`/`atEnd`** — the playable-action count was threaded workbench → snapshot-pane → controls only for prev/next disabled state; the controller now exposes `atStart`/`atEnd` and the param is gone from all three.                                                                                                                                                                | `playback-controls.tsx`, `snapshot-pane.tsx`, `trace-viewer.tsx`                                               |

## Convention & boundary fixes

- **`Field`/`Section` now `cn()`-merge** (house convention) instead of
  `className ?? default` full-replacement. That footgun had spawned a
  `className=""` "reset" in `call-tab` and a whole `MetaField` wrapper in
  `metadata-tab` — both deleted; `Field` gained a `variant` (`mono`/`plain`/
  `bare`). Added `formatWallClock` to `format.ts` and routed both tabs' raw
  `toLocale*` calls through it. (`detail-shared.tsx`, `call-tab.tsx`,
  `metadata-tab.tsx`, `format.ts`)
- **react-query restored** in `ReplayModalHost` — the branch had swapped
  `useQuery({ staleTime: ∞, signal })` for a hand-rolled `useEffect` + cancelled
  flag, dropping abort + immutable-trace caching. Restored `useQuery`, merged
  with the branch's `attempts` shape. (`trace-viewer-dialog.tsx`)
- **Dead `traceViewerUrl` removed from the replay `attempts` contract** — it was
  minted per-attempt but never read (the switcher/viewer use `downloadHref`).
  Dropped from `TestReplayResponse` and the dialog's `TestReplayAttempt`, which
  cascaded out the now-unused `origin`/`resolvePublicOrigin`/`env` in
  `replay.ts`. (`replay.ts`, `trace-viewer-dialog.tsx`)

### Follow-up: MCP now links to our self-hosted viewer, not trace.playwright.dev

Tracing the review's "the self-hosted SPA is dead" claim revealed the opposite
problem: MCP's `get_artifact` was handing out a **`trace.playwright.dev`** link
(`traceViewerUrlFor`) — shipping trace bytes to a third party, the exact leak the
vendored viewer exists to avoid. Meanwhile the two helpers had diverged:
`signedTraceViewerUrl` (rail, self-hosted, but used only as a boolean gate) vs
`traceViewerUrlFor` (MCP, public). Unified both into one
`selfHostedTraceViewerUrl(absoluteDownloadUrl)` (absolute, same-origin) and
switched **MCP to it**, so an agent/user's viewer link now keeps the trace on
this dashboard. The native React viewer can't serve MCP — it only opens as a
tenant-scoped, auth-gated dialog; the self-hosted SPA works cold from a signed
URL. (`artifact-tokens.ts`, `mcp/server.ts`, `test-artifact-actions.ts` +
signing/token tests)

- **`warm.ts`** gained `releaseWarmedTrace()`, called when the modal mounts its
  own authoritative bridge, so the hover-prewarm iframe stops pinning the trace
  for the whole session. Vendor-script header comments updated for the native-
  viewer architecture (they still described the retired iframe-embed SPA).
- **Doc-rot**: `snapshot-pane`'s header described a `location.replace` in-place
  iframe navigation that doesn't exist (grep-confirmed comment-only; frames are
  keyed by URL and remount). Rewritten to point at `BufferedSnapshotFrame`.
- **a11y**: the concurrent tooltip pass had left two icon-only buttons
  (attachments-expand, detail-tabs crosshair) without an accessible name after
  swapping `title=` for a visual `<Tooltip>`; added `aria-label`s and updated the
  two tests that queried them by title.

## Follow-up: decompositions (all done)

The pure, behavior-preserving file-splits from the review's file-size axis,
landed as separate commits after the code-judo pass:

- **`network-tab.tsx` 737 → 339** — pure column/sort/classification helpers to
  `network-columns.ts` (unit-testable, no React); the request detail panel to
  `network-detail-panel.tsx`.
- **`snapshot-pane.tsx` 456 → 249** — the scale + double-buffer iframe stage to
  `snapshot-stage.tsx`.
- **`action-list.tsx` 489 → 351** — the collapse/override/auto-reveal state
  machine + the visible-row walk to `use-action-tree-collapse.ts` (one scope,
  one dependency set); `ActionRow` chevron rendered once (was a 3-way branch);
  `usePersistentGroupSet` folds the localStorage read + write.
- **`playback-controls.tsx` 426 → 119** — engine + time-search primitives to
  `use-playback.ts`, the rAF line to `playhead.tsx`.
- **`timeline.tsx`** — the click-seek / drag-select / hover pointer machine
  lifted into a `useTimelineSeek` hook (the ~90-line render body now reads
  measure → scale → seek-machine → derive → compose).
- **`ScopedEmpty`** now owns the scope-vs-range message choice both windowed
  tabs duplicated; a shared `TabEmpty` replaces hand-rolled `<Empty>` blocks.

Not pursued (marginal): breaking the timeline's overlay JSX into presentational
components (`timeScale` already made that geometry uniform).

## Follow-up: MCP → self-hosted viewer (see the boundary section above)

`get_artifact` now returns a same-origin self-hosted viewer link via the unified
`selfHostedTraceViewerUrl`, replacing the third-party `trace.playwright.dev`.

## Verification

- `pnpm check` — exit 0 (0 errors, 140 pre-existing warnings) after every commit.
- Full node lane (`vp test run`) — 512 passed, 4 skipped.
- Full workers lane (`vitest -c vitest.workers.config.ts`) — 1314 passed.
- Trace-viewer suites specifically — 196 passed; the two pre-existing tooltip-
  pass failures (`snapshot-pane` / `attachments-tab` `getByTitle`) are fixed.
