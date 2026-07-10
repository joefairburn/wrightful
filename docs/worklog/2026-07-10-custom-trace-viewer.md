# 2026-07-10 — Custom trace viewer: native Replay workbench on the vendored Playwright SW engine

## What changed

Replaced the Replay modal's **iframe of the official Playwright trace viewer**
with **Wrightful's own trace viewer** — a React workbench built from our
component library (`ui/` + tokens), living in a dedicated
`apps/dashboard/src/trace-viewer/` folder. The hard machinery is NOT
re-implemented: DOM-snapshot rendering, trace.zip range-reading, and the
9-version format modernizer stay in Playwright's own compiled service worker
(`sw.bundle.js`, already vendored into `public/trace-viewer/`), which our UI
drives over its HTTP contract. The official viewer bundle stays vendored and
reachable via an "Official viewer" new-tab button as a rollout fallback.

Architecture (the key insight, verified against the shipped 1.61.1 bundle —
see `.context/custom-trace-viewer-feasibility.md` for the full investigation):

- **The SW serves its endpoints only in specific ways.** `contexts?trace=` /
  `snapshotInfo/` / `sha1/` fetches require a **controlled client** (a page
  under the `/trace-viewer/` scope); for a controlled client, any sub-resource
  request OUTSIDE that scope is resolved against the trace archive (or 404s)
  instead of the network. So the dashboard page itself must never be
  controlled — Void island assets and API calls would be swallowed.
- **Snapshot documents are navigation requests**, which the SW serves by URL
  scope regardless of who creates the iframe. So snapshot iframes can be
  rendered directly from the (uncontrolled) dashboard React tree.
- Bridging the two: a **hidden bridge iframe** (`bridge.html`, ours, copied
  into the SW scope by the vendor script) registers the SW, keeps it alive
  (`ping` every 10s; its client entry also pins the SW's trace cache), fetches
  the parsed + modernized model from `contexts?trace=<signed download URL>`,
  and relays progress/model/errors to the parent via postMessage. It is fully
  inline (a controlled document must not load subresources).

So the modal now hosts native components (tooltips, theme, focus, Escape all
first-class) — no full-viewer iframe at all; only the DOM-snapshot documents
are iframed, exactly like the official viewer does internally.

## Details

| Area                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/trace-viewer/vendor/`            | Playwright's trace-model **source** (Apache-2.0), vendored verbatim from tag v1.61.1: `trace.ts` (event types, VERSION 8), `entries.ts` (`ContextEntry` — the `contexts` JSON shape), `model-util.ts` (`TraceModel`: step/action merging via `stepId`, clock-delta correction, action tree, `eventsForAction`/`stats`), `har.ts`, plus small deps (`snapshot.ts`, `protocol-types.ts`, `protocol-formatter.ts`, `protocol-metainfo.ts`, `language.ts`). Every file carries a `VENDOR-PROVENANCE` header; nothing is published on npm (upstream packages are `private: true`), so source-vendoring is the only consumable form — maintainers explicitly recommend hosting copies (playwright#30198).                                                                                          |
| Drift guards                          | `vendor/version.ts` pins the synced tag; `src/__tests__/trace-viewer-vendor.test.ts` fails when the installed playwright-core moves past it (message = re-sync procedure). The rewritten replay e2e doubles as the runtime contract test: it drives a REAL trace through the REAL SW (action list + snapshot doc), so a playwright-core bump that changes the SW contract or model shape fails CI, not production.                                                                                                                                                                                                                                                                                                                                                                           |
| `src/trace-viewer/bridge.html`        | The SW bootstrap bridge (see above). Mirrors the official bootstrap including the Local-Network-Access retry (`x-pw-serviceworker: skip` HEAD).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/trace-viewer/use-trace-model.ts` | React hook: mounts the hidden bridge, origin/source-checked postMessage protocol, 30s timeout, returns `loading (progress) / error / ready (contextEntries)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/trace-viewer/model.ts`           | Adapter: `collectSnapshots` (faithful port of the official before/after fallback walks over the model's prev/next-by-time links), `snapshotIframeUrl` (`/trace-viewer/snapshot/<pageId>?trace=&name=&pointX=&pointY=`), `sha1DownloadUrl` (attachment bytes; navigation-only), `defaultSelectedActionId` (first failed else last), `describeTraceLoadError` (friendly `TraceVersionError` copy).                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/trace-viewer/components/`        | The workbench: `trace-viewer.tsx` (loader states + layout), `action-list.tsx` (merged action tree: status, params hint, duration, per-action console error/warning badges, keyboard nav), `snapshot-pane.tsx` (Before/Action/After tabs, viewport-scaled SW-served snapshot iframe), `detail-tabs.tsx` (Log/Errors/Console/Network/Attachments/Metadata; counts on labels), the five tab panels, `split-pane.tsx` (bespoke pointer-drag splitter — no split-pane existed in `ui/` and a dependency wasn't warranted), `escape-frames.ts` (the cross-frame Escape binder, moved verbatim from the dialog where its original iframe is now gone). Built on `TabBar`/`ScrollArea`/`Table`/`Empty`/`Button` + `text-fail`/`text-warning`/ramp tokens; passes the `token-conventions` guard test. |
| `trace-viewer-dialog.tsx`             | `TestReplayContent` now renders `<TraceViewer traceUrl={absolute signed downloadHref}>` instead of the viewer iframe; `bindEscapeAcrossFrames` and the iframe machinery removed from the dialog (snapshot-level Escape binding lives in the snapshot pane). Header buttons: **Official viewer** (new tab, the still-vendored `/trace-viewer/index.html?trace=…` — was "New tab"), Download, Public viewer. `?replay=` deep-linking, `ReplayModalHost`, and the `/replay` endpoint are unchanged.                                                                                                                                                                                                                                                                                             |
| `scripts/vendor-trace-viewer.mjs`     | Additionally copies `src/trace-viewer/bridge.html` into `public/trace-viewer/` on EVERY run (including the version-stamped skip path — the bridge changes with our source, not the pin).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E2E                                   | `test-replay.spec.ts` rewritten: header test now covers `sw.bundle.js` + `bridge.html` + `index.html`; the two flow tests assert the native workbench (`listbox "Actions"` populated, `iframe[title="DOM snapshot"]` with a `/trace-viewer/snapshot/…?trace=` src) instead of the old full-viewer iframe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unit tests                            | `trace-viewer-model.test.ts` (10 tests): drives the vendored `TraceModel` with a synthetic `ContextEntry` payload; pins `collectSnapshots` fallback semantics, snapshot/sha1 URL shapes, default selection, version-error copy. Plus the vendor-version guard test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Why vendor source instead of importing the package?

The npm `playwright-core` package ships only compiled/minified bundles and its
`exports` map exposes none of the trace model. The readable source lives in
never-published private packages in the playwright monorepo. Options were:
copy faithfully (mechanically diffable against the upstream tag on every
bump), re-implement (drifts silently), or nothing. The engine itself
(`sw.bundle.js`) is NOT copied into src — it's taken from the installed
playwright-core at build time, so it cannot drift from the pin by
construction. Drift can only enter when bumping playwright-core, and both
guards (version test + replay e2e) fire exactly then.

## Verification

- **Static:** `pnpm check` → 0 errors, 130 warnings — exactly the pre-existing
  baseline; the vendored files contribute zero (scoped `oxlint-disable`
  headers for upstream naming conventions).
- **Unit:** dashboard node lane 290 passed / 4 skipped (includes the 10 new
  model tests, the vendor-version guard, and the `token-conventions` design
  guard); workers lane 1222 passed.
- **Real-browser, real-trace:** booted the dashboard against local Postgres,
  seeded via `seed-demo.mjs` + `upload-fixtures.mjs` (7 real traces through
  the live ingest path), drove Chromium through login → run detail → Replay:
  action list rendered 19 rows from the merged model, the failed
  `expect(toHaveText)` auto-selected, the SW-served snapshot document rendered
  the actual page DOM, ANSI-colored error panel correct, all six tabs render,
  Escape closes the modal and clears `?replay=`. Screenshots verified in dark
  mode.
- **Dashboard e2e (isolated boot):** `pnpm --filter @wrightful/e2e
test:dashboard test-replay.spec.ts` → **3/3 passed** (fresh `_e2e` DB, own
  server on :5189, fixtures generated by real Playwright runs).

## Known scope cuts (deliberate, follow-ups)

- **No timeline/filmstrip scrubber yet** (screencast frames are in the model;
  Phase 2).
- **No Source tab** (`model.sources` content requires a controlled-client
  `sha1/` fetch; needs a small bridge fetch-proxy — same mechanism would also
  unlock the `snapshotInfo/` URL bar + exact per-snapshot viewport; today the
  context viewport is used, which is only wrong if a test resizes mid-run).
- **No locator-picking / inspect mode** (official does it by injecting a live
  recorder script into the snapshot iframe — out of MVP scope).
- **Attachment inline previews**: sha1-backed bytes are navigation-only from
  the dashboard (SW constraint), so attachments are download links; inline
  `<img>` previews would also ride the bridge fetch-proxy.
- The `/trace-viewer/*` CSP carve-out is unchanged; once the official-viewer
  fallback is retired, `unsafe-eval` can likely be dropped from it (the SW +
  snapshot docs don't need it).
