# 2026-07-15 — Trace viewer: thermo-nuclear review, round 2

A second strict `/thermo-nuclear-code-quality-review` over the
`custom-trace-viewer` branch (the first round is
`2026-07-14-trace-viewer-thermo-nuclear-review-fixes.md`), followed by applying
every finding. The review ran as five parallel read-only audits (core
model/hooks, workbench components, detail tabs, dashboard integration + vendor
pipeline, test corpus); the fixes ran as three waves of parallel subagents with
strictly disjoint file ownership per wave. All behavior-preserving except the
blocker and the three approved semantic fixes called out below.

## BLOCKER — the replay e2e asserted a field the branch itself deleted

`packages/e2e/tests-dashboard/test-replay.spec.ts` still asserted
`attempts.at(-1)?.traceViewerUrl` — a field round 1 removed from the replay
route's contract (`{ attempt, downloadHref }` since 81eff2f). `typeof null ===
"object"` → guaranteed red in CI; round 1's verification only ran the vitest
lanes, so the Playwright dashboard suite never caught it. The spec now asserts
`downloadHref` against `signedDownloadHref`'s real shape
(`/api/artifacts/<id>/download?t=…`) and keeps a third-party-leak guard. The
suite could not be booted in the sandbox (no Postgres) — statically verified
against the route source; **run `pnpm --filter @wrightful/e2e test:dashboard`
before merge**.

## Semantic fixes (approved behavior changes)

| Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Files                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **`defaultSelectedActionId` → vendor parity.** Our `find(a => a.error?.message)` picked the _earliest_ failed action; vendor `failedAction()` is `findLast(a => a.error)` — deliberately the **innermost** failed action for nested `test.step` failures (errors propagate onto wrappers, which sort parent-first). Now `(model.failedAction() ?? model.actions.at(-1))?.callId`. New nested-failure pinning test.                                                           | `model.ts`, `trace-viewer-model.test.ts`                     |
| **Bridge load timeout is now a true silence watchdog.** `BRIDGE_TIMEOUT_MS` (30s) was armed once per load — a large trace actively streaming `progress` got killed at 30s with a misleading "service worker may be blocked" error. The timer now re-arms on every valid bridge message from the loading iframe; 30s bounds only true silence. Regression test advances fake timers past 30s total with progress in between (mutation-tested: disabling the re-arm fails it). | `use-trace-model.ts`, `trace-viewer-hooks.test.tsx`          |
| **Dialog attempt selection scoped to its test.** `TestReplayContent` held `selectedAttempt` in plain `useState`; with react-query `staleTime: ∞`, navigating between two cached `?replay=` deep links swapped the data without a remount, carrying test A's attempt selection into test B. Fixed with `key={replay}`; regression test pre-seeds the query cache for two ids and asserts the reset.                                                                           | `trace-viewer-dialog.tsx`, `trace-viewer-dialog.test.tsx`    |
| **Source-tab fetch key encodes the trace URL.** `useBridgeFetch`'s contract (ref-latest loader; only `key` refetches) implies the key must encode every loader input — source-tab keyed on the bare file path while the loader read `traceUrl`/`model`, so an attempt swap with a recurring path served the _previous_ trace's text. Key is now `` `${traceUrl}#${file}` `` (the `snapshotInfoKey` idiom) and the invariant is stated on `useBridgeFetch`'s doc.             | `source-tab.tsx`, `use-bridge-fetch.ts`                      |
| **Register-only warm iframe no longer leaks.** The no-arg `warm()` path mounted a bridge iframe and never removed it (one per session). It now removes itself on the bridge's `warm` ack (validated via the exported `isBridgeMessage` envelope guard) with a 10s fallback.                                                                                                                                                                                                  | `warm.ts`, `use-trace-model.ts`, `trace-viewer-warm.test.ts` |

## Code-judo / contract simplifications (behavior-preserving)

| Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Files                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **`traceUrl` folded into `TraceBridge`.** `TraceTabProps.traceUrl` invariantly equaled `model.traceUri`; the `{bridge, traceUrl}` pair was re-threaded through ~10 leaf signatures. `TraceBridge` now carries `readonly traceUrl`; the prop is gone from `TraceTabProps` and every leaf (tabs, attachment leaves, network detail panel, body preview, snapshot pane). `TraceViewer`'s public top-level prop is unchanged.                                                                                                                                                                                                              | `use-trace-model.ts`, `trace-viewer.tsx`, all tab files, `snapshot-pane.tsx`, fixture + suites                     |
| **`TraceTabProps` relocated** from `model.ts` (a model-derivation module) to its owner, `components/detail-tabs.tsx`. The pure modules (`network-columns.ts`, `source-highlight.ts`) now name vendor `TraceModel` directly instead of indexing a component prop contract.                                                                                                                                                                                                                                                                                                                                                              | `detail-tabs.tsx`, `model.ts`, importers                                                                           |
| **Single tab registry.** `detail-tabs.tsx` enumerated the tab set three times (labels array, eight `activeTab === "x"` ternaries, a `scopable` hardcode). One `TabConfig[]` (`{id, label, count?, scopable?, render}`) drives bar, body, and scoping.                                                                                                                                                                                                                                                                                                                                                                                  | `detail-tabs.tsx`                                                                                                  |
| **`LogTab` extracted** to `log-tab.tsx` (it was a ninth tab hiding in the switchboard, copy-pasting ConsoleTab's offset grid). Shared `OFFSET_GRID_CLASSES`/`OffsetCell` in `detail-shared.tsx`, consumed by Log + Console; Log's hand-rolled 3-way empty message now uses `TabNotice`/`ScopedEmpty`.                                                                                                                                                                                                                                                                                                                                  | `log-tab.tsx` (new), `detail-shared.tsx`, `console-tab.tsx`                                                        |
| **Playback controller is the contract.** `PlaybackControls` takes `playback: PlaybackController` (was a 9-prop field-by-field unpacking); the playable set lives on the controller (killing the Timeline's parallel `playableActions` pass-through prop); `usePlayback` takes `selectedAction` (was two fields of it) and `model` — `playing` is now `useModelScopedState`, deleting the workbench's effect-based pause-on-swap (and its one-frame stale-playing gap). Timeline's verbatim re-derivation of `selectedAction` deleted. `TimelineAction` is now a real `Pick<…>` of what playback/timeline touch, not an identity alias. | `use-playback.ts`, `playback-controls.tsx`, `snapshot-pane.tsx`, `trace-viewer.tsx`, `timeline.tsx`                |
| **Timeline `HoverOverlay`.** The hover preview's seven null-guarded derivations moved into a component that receives a _narrowed_ non-null hover — the `hover?.below ?? false` / `hoverTime ?? 0` silent fallbacks are gone. `TimeScale` gained `percentAt({clamp})`/`spanPercent`, and all ~7 hand-rolled `fraction * 100` sites route through it (the four `selected*/selection*Fraction` intermediates deleted). Bars lane / selection shroud deliberately NOT extracted (pure JSX relocation — reviewed and rejected).                                                                                                             | `timeline.tsx`                                                                                                     |
| **Attachments preview re-unified.** `AttachmentRow` had re-grown the text-preview arm `BridgeBodyPreview` was extracted to own (already drifted: wrap class + strings). Shared `PreviewPre` + `useSha1PreviewText` now live in `body-preview.tsx`; the triplicated `data:…;base64,` literal is one `attachmentDataUrl`; the base64-vs-sha1 fork is one `useAttachmentMediaUrl`. `isVideoMime` added to `mime.ts` (the raw `startsWith("video/")` hole).                                                                                                                                                                                | `attachments-tab.tsx`, `body-preview.tsx`, `mime.ts`                                                               |
| **Honest console types.** `ConsoleRow` is now `ConsoleMessageTraceEvent \| (EventTraceEvent & { method: "pageError" })` so the guard actually narrows and the pageError assumptions downstream are compiler-checked. `isConsoleRow` + `buildErrorPrompt` unexported (zero external consumers).                                                                                                                                                                                                                                                                                                                                         | `console-tab.tsx`, `errors-tab.tsx`                                                                                |
| **Honest optionality.** `ActionList`'s `onHover`/`selection`/`onClearSelection` and `DetailTabs`' `selection` are required (sole caller always passed them); `DetailTabs` props are `Omit<TraceTabProps, "scopeToSelected">` instead of seven re-declared indexed fields.                                                                                                                                                                                                                                                                                                                                                              | `action-list.tsx`, `detail-tabs.tsx`                                                                               |
| **`shortUrl` on `basename`.** With a parity catch: the review's literal suggestion would have regressed trailing-slash URLs (`basename("/x/") === ""`); the swap strips trailing slashes first — old/new verified identical across edge cases by tests written _before_ the swap.                                                                                                                                                                                                                                                                                                                                                      | `network-columns.ts`                                                                                               |
| **Dead `origin` chain deleted.** Removing the write-only `traceViewerUrl` (below) orphaned `signArtifactRows`' `origin` param → `loadAttemptArtifactGroups`' param → the page loader's `resolvePublicOrigin(env, url.origin)` computation → `resolvePublicOrigin` itself (zero production callers; only its own tests). All deleted end-to-end.                                                                                                                                                                                                                                                                                        | `test-artifact-actions.ts`, `…/tests/[testResultId]/index.server.ts`, `lib/config.ts`, `config.workers.test.ts`    |
| **Write-only `traceViewerUrl` dropped from the UI artifact contract.** It was minted (signed!) per trace row but only ever consumed as a truthiness gate ≡ `type === "trace"`. Gates now check the type; `selfHostedTraceViewerUrl` remains for its one real consumer (MCP).                                                                                                                                                                                                                                                                                                                                                           | `test-artifact-actions.ts`, `artifact-actions.tsx`, `artifacts-rail.tsx`, `trace-viewer-dialog.tsx`, signing tests |
| **`source-highlight.ts` extracted** — `sha1Hex`, `pickDefaultFile`, dialect table + `tokenizeSource` (~120 React-free lines out of `source-tab.tsx`), with a direct suite pinning the line-count invariant (incl. CRLF, empirically probed), non-JS fallback, and a real SHA-1 vector.                                                                                                                                                                                                                                                                                                                                                 | `source-highlight.ts` (new), `source-tab.tsx`                                                                      |
| **Dedup in `use-trace-model.ts`** — the twice-copy-pasted reject-all-pending loop hoisted to one `rejectAllPending`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `use-trace-model.ts`                                                                                               |
| **One SW-scope path source of truth** — `BRIDGE_PATH` derives from `TRACE_VIEWER_SCOPE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `bridge-iframe.ts`                                                                                                 |
| **`AnsiPre` claim made true** — gained an `inline` (span) variant; `test-error-alert`'s second inline `dangerouslySetInnerHTML` now routes through it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `ansi-pre.tsx`, `test-error-alert.tsx`                                                                             |
| **`sync-trace-vendor.mjs --pr` deleted** — the half-automated branch/commit/print-the-rest mode (~70 lines incl. an embedded PR-body heredoc); nothing referenced it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `scripts/sync-trace-vendor.mjs`                                                                                    |

## UI-convention pass

`PlaybackButton` and the snapshot popout (its `<a>`/`<button disabled>` fork
collapsed via Base UI's `render` prop) now render through
`ui/button size="icon-xs" variant="ghost"`; the two hand-rolled
`role="progressbar"` blocks are one `TraceProgress` on `ui/progress` (native
aria + `value={null}` indeterminate) with a single `fractionOf` helper; the six
copy-pasted network `SortableHead`s are a mapped `NETWORK_COLUMNS` table
(byte-identical DOM); the action-list filter input consumes a new
`FILTER_INPUT_CLASSES` export from `filter-controls.tsx` instead of a byte-copy
of `ComboboxFilterPopup`'s input string.

## Doc-rot fixes

`artifact-tokens.ts`'s two TTL docstrings again point at `serveArtifactBytes`
as the single presign-cap home (they still described the pre-round-1 world —
the exact stale-pointer failure mode behind the original 8h-presign
regression). Stale e2e spec comments describing the deleted field rewritten;
`action-list.tsx`'s orphaned `hasErrorInSubtree` docstring deleted.

## Test-corpus maintainability

- **`makeResource` / `makeConsoleEvent` / `makePageErrorEvent`** fixture
  builders (cast-free — typed directly against the vendored HAR/trace types)
  replace three ~40-line `as unknown as` literals; the casts that severed the
  compile-time link to `vendor/har.ts` are gone. Network-tab's two local
  literals collapsed to 7–9 override lines each.
- **`renderDetailTabs(overrides)`** replaces the 13 hand-written 8-prop
  `<DetailTabs>` blocks.
- **New direct suites** for the extracted pure modules:
  `trace-viewer-network-columns.test.ts` (31), `trace-viewer-mime.test.ts`
  (22), `trace-viewer-source-highlight.test.ts` (24) — all characterization
  tests written against current behavior. Notable pinned quirks (deliberate,
  not "fixed"): mime classifiers are case-sensitive; `isTextMime` and
  `isImageMime` are both true for `image/svg+xml`; `compareEntries` desc-ties
  return `-0`.
- **Brittle class-string assertions** in the source-tab suite retargeted at new
  `data-current-line` / `data-line-number` attributes.

## Reviewed and deliberately NOT changed

- The three parallel fetch ladders (`useBridgeFetch`, `useObjectUrl`,
  `useBufferedObjectUrl`) stay separate — consolidation would reintroduce the
  stale-frame flash the buffered hook exists to prevent; the relationship is
  documented in `use-bridge-fetch.ts`.
- Timeline bars lane / selection shroud extraction (JSX relocation, no
  complexity deleted).
- `useSnapshotInfo`'s tiny per-mount cache is unbounded across attempt swaps —
  entries are ~a URL + viewport; noted, not worth eviction machinery.
- **Branch drift flagged for a human call, not auto-fixed:** `skills-lock.json`
  adds three third-party design skills, and
  `packages/e2e/tests/visual-regression.spec.ts-snapshots/homepage-linux.png`
  (313 KB) landed with no demo-suite spec change — neither belongs to the
  trace viewer; confirm intent or split out.

## Verification

- `pnpm check` — exit 0 (0 errors, 140 warnings — the same pre-existing count
  as round 1; the one new warning the pass introduced was fixed by exporting
  `isBridgeMessage` instead of casting in `warm.ts`).
- Full `pnpm test`: dashboard node lane 592 passed / 4 skipped (up from 512 —
  the new direct suites); dashboard workers lane 1311 passed (down 3 = the
  deleted `resolvePublicOrigin` tests); reporter 295 passed.
- `pnpm --filter @wrightful/dashboard run typecheck` (void prepare + tsgo) —
  clean.
- NOT run (no Postgres in the sandbox): the Playwright dashboard e2e suite —
  the blocker fix was statically verified against the route; run
  `pnpm --filter @wrightful/e2e test:dashboard` before merge.
