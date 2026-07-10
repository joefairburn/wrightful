# 2026-07-10 — Trace viewer phase 3: parity pass with the official viewer

## What changed

Third pass, closing the practical feature gaps to Playwright's own viewer
(same day as the phase-1/phase-2 entries; see those for the architecture).

| Feature                                                           | Notes                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Call tab** (`call-tab.tsx`, now the default tab when no errors) | Selected action's start (offset + wall clock), duration, page, callId, parameters (pretty JSON, capped), return value, ANSI error.                                                                                                                                                                                                                           |
| **Network detail drawer** (network-tab)                           | Rows selectable; drawer with General / Timing (stacked HAR-phase bar, `bg-chart-*` tokens) / request+response headers / request body / response body preview (images via the bridge proxy, text/JSON pretty-printed, size-capped fallback).                                                                                                                  |
| **Action search** (action-list)                                   | `SearchFilterInput` filtering the tree (matches title + selector/url/expression hint, keeps ancestors, ignores collapse while searching).                                                                                                                                                                                                                    |
| **Timeline: action bars + hover preview** (timeline)              | 8px lane of per-action bars (fail red, selected accent) between axis and filmstrip; hovering shows a floating screencast-frame preview card (keyed by frame sha1) with the time label.                                                                                                                                                                       |
| **Snapshot popout + canvas toggle** (snapshot-pane)               | "Open in new tab" via the vendored `snapshot.html?r=…` shell; persisted toggle passes `shouldPopulateCanvasFromScreenshot=1` to snapshot URLs.                                                                                                                                                                                                               |
| **Attachment text previews** (attachments-tab)                    | `text/*` + JSON attachments expand inline (proxied sha1 / base64, 50k cap, pretty JSON).                                                                                                                                                                                                                                                                     |
| **Copy prompt** (errors-tab)                                      | Official 1.51-parity LLM-debugging button: error + failing action + top frame, `useCopiedFlag` feedback.                                                                                                                                                                                                                                                     |
| **Source tab: stack-frames pane** (source-tab)                    | Right-hand frame list; clicking switches file + scroll-highlights the frame's line; frames without captured source disabled.                                                                                                                                                                                                                                 |
| **Bridge error diagnostics** (bridge.html)                        | On load failure the bridge probes the trace URL directly and appends the REAL HTTP status + a hint (404 → "artifact bytes missing… re-run the fixture seed", 401/403 → token expired). Motivated by a real local-dev report where a 404 (DB row present, dev R2 state reset) surfaced as the official viewer's misleading "grant Local Network Access" copy. |

**Attempted and reverted:** CodeMirror-based syntax highlighting for the
Source tab. Custom decoration extensions hit "multiple instances of
@codemirror/state" under Vite dev pre-bundling (instanceof breakage across
pre-bundle graphs — the existing `CodeMirrorField` consumer is unaffected
because it passes no custom extensions), silently falling back to the `<pre>`
renderer with a console error. The additive wrapper props were reverted with
it; revisit only with a vite dedupe/optimizeDeps fix. The plain renderer
keeps line numbers, target-line highlight + scroll, and inline error rows.

**Known coverage gap:** the network drawer was verified by typecheck +
component-level reasoning only — every seeded fixture trace uses
`setContent` (zero network entries), so no live drawer screenshot exists.
Component tests cover it (see the test-coverage worklog); consider adding a
fixture spec that performs a real `page.goto` + `fetch` so traces carry
network entries.

**Deliberately out of scope:** pick-locator/inspect mode — requires
Playwright's `InjectedScript`/`Recorder` bundle, which ships only inside the
minified official UI chunk; no reuse seam exists.

## Verification

- `pnpm check` → 0 errors (133-warning repo baseline).
- Node lane 291 passed / 4 skipped; workers lane previously green and
  untouched by this pass.
- Real-browser (Chromium, seeded traces): Call tab renders parameters;
  search narrows 17 actions → 1 for "expect"; timeline hover preview card +
  action bars visible; popout link + canvas toggle present; Copy prompt
  button renders; Source tab renders 166 source lines with the frames pane;
  attempt switcher/Escape regression-checked. Screenshots captured.
- Isolated dashboard e2e `test-replay.spec.ts` → 3/3.
