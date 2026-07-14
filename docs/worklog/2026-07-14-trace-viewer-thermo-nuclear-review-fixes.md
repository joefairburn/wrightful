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
  `replay.ts`. **Kept** `signedTraceViewerUrl`/`TRACE_VIEWER_PATH` — the review
  implied the self-hosted `/trace-viewer/index.html` SPA was dead, but the MCP
  server (`traceViewerUrlFor`) hands users that link, and the artifacts-rail
  gate still consumes `ArtifactAction.traceViewerUrl`. (`replay.ts`,
  `trace-viewer-dialog.tsx`)
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

## Deferred (documented, not done)

Pure file-decomposition / lower-value dedups intentionally left as follow-ups —
the review prioritized code-judo over file-splitting, and all of that is done.
The large components did shrink (e.g. `network-tab` lost `ResponseBodyPreview`),
but none of these were pursued:

- Extract `useActionTreeCollapse` from `action-list.tsx`; collapse the
  `ActionRow` chevron three-way branch; a `usePersistentGroupSet` hook.
- Split `playback-controls.tsx` into engine / `playhead` / controls;
  `useTimelineSeek` + presentational overlay components in `timeline.tsx`;
  `snapshot-stage.tsx` out of `snapshot-pane.tsx`; `network-columns.ts` out of
  `network-tab.tsx`.
- `ScopedEmpty` empty-state / scoped-message consolidation across the tabs.

## Verification

- `pnpm check` — exit 0 (0 errors, 140 pre-existing warnings).
- Full node lane (`vp test run`) — 512 passed, 4 skipped.
- Full workers lane (`vitest -c vitest.workers.config.ts`) — 1314 passed.
- Trace-viewer suites specifically — 196 passed; the two pre-existing tooltip-
  pass failures (`snapshot-pane` / `attachments-tab` `getByTitle`) are fixed.
