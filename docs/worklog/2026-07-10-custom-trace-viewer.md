# 2026-07-10 — Custom trace viewer: native Replay workbench on the vendored Playwright SW engine

Consolidated log for the whole trace-viewer effort (foundation + parity + phase-2
features + playback polish + test coverage), all shipped 2026-07-10.

## What changed

Replaced the Replay modal's **iframe of the official Playwright trace viewer**
with **Wrightful's own trace viewer** — a React workbench built from our
component library (`ui/` + tokens) in `apps/dashboard/src/trace-viewer/`. The
hard machinery is NOT re-implemented: DOM-snapshot rendering, trace.zip
range-reading, and the 9-version format modernizer stay in Playwright's own
compiled service worker (`sw.bundle.js`, vendored into `public/trace-viewer/`),
which our UI drives over its HTTP contract. The official viewer bundle stays
vendored and reachable via an "Official viewer" new-tab button as a rollout
fallback.

## Architecture

Verified against the shipped 1.61.1 bundle (full investigation in
`.context/custom-trace-viewer-feasibility.md`):

- **The SW serves endpoints only for a _controlled_ client.** `contexts?trace=`
  / `snapshotInfo/` / `sha1/` fetches require a page under the `/trace-viewer/`
  scope; for a controlled client, any sub-resource request OUTSIDE that scope
  resolves against the trace archive (or 404s) instead of the network. So the
  dashboard page itself must never be controlled — its island assets and API
  calls would be swallowed.
- **Snapshot documents are navigation requests**, served by URL scope
  regardless of who creates the iframe — so snapshot iframes render directly
  from the (uncontrolled) dashboard React tree.
- **Hidden bridge iframe** (`bridge.html`, ours, copied into SW scope by the
  vendor script) registers + keeps the SW alive (`ping` every 10s), fetches the
  parsed+modernized model from `contexts?trace=<signed download URL>`, and
  relays progress/model/errors to the parent via origin/source-checked
  postMessage. Fully inline (a controlled document must not load subresources).
- **Bridge fetch-proxy** (the key phase-2 addition): `bridge.html` exposes a
  postMessage RPC (`method:"fetch", path, as:"json"|"blob"`) that fetches from
  inside the controlled client (path validated to stay under `/trace-viewer/`)
  and replies with a structured-cloneable body. This one mechanism unblocked
  the filmstrip, Source tab, inline previews, snapshot URL bar / exact viewport,
  and network body previews. `use-trace-model.ts` returns a stable `TraceBridge`
  (`fetchJson`/`fetchBlob`, per-request timeout, pending-map rejected on
  unmount); `use-object-url.ts` wraps blobs into objectURLs.

The modal now hosts native components (tooltips, theme, focus, Escape all
first-class); only DOM-snapshot documents are iframed, exactly as the official
viewer does internally.

## Vendoring & drift guards

- `src/trace-viewer/vendor/` — Playwright trace-model **source** (Apache-2.0),
  vendored verbatim from tag v1.61.1 (`trace.ts`, `entries.ts`, `model-util.ts`,
  `har.ts`, `snapshot.ts`, `protocol-*`, `language.ts`). Every file carries a
  `VENDOR-PROVENANCE` header. These packages are never published on npm and
  `playwright-core` ships only minified bundles with no trace-model export, so
  source-vendoring is the only consumable form (maintainers recommend hosting
  copies — playwright#30198). The engine (`sw.bundle.js`) is taken from the
  installed playwright-core at build time, so it cannot drift from the pin by
  construction.
- `vendor/version.ts` pins the synced tag; `trace-viewer-vendor.test.ts` fails
  when installed playwright-core moves past it. The replay e2e doubles as the
  runtime contract test (real trace → real SW), so a playwright-core bump that
  changes the SW contract or model shape fails CI, not production.
- `scripts/vendor-trace-viewer.mjs` copies `bridge.html` into
  `public/trace-viewer/` on every run (the bridge tracks our source, not the pin).
- `scripts/sync-trace-vendor.mjs` (`pnpm --filter @wrightful/dashboard
sync:trace-vendor`) re-downloads the 7 verbatim files from the tag matching
  installed playwright-core, re-applies the import-rewrite table + preserved
  headers + documented `bodyPatches`, bumps `version.ts`, flags the 2
  hand-extracted files for manual review. `--dry-run` (fetch+diff) proves every
  file byte-identical after the round-trip; `--pr` opens a PR (degrades to
  printed manual commands when unauthenticated).

## Workbench & features

Core files: `trace-viewer.tsx` (loader states + layout), `action-list.tsx`,
`snapshot-pane.tsx`, `detail-tabs.tsx` + tab panels, `timeline.tsx`,
`split-pane.tsx` (bespoke pointer-drag splitter — none existed in `ui/`),
`escape-frames.ts`, `model.ts` (snapshot fallback walks, URL builders, default
selection, error copy). `trace-viewer-dialog.tsx` renders `<TraceViewer>`
instead of the old iframe; header buttons are Official viewer / Download /
Public viewer. `?replay=` deep-linking, `ReplayModalHost`, and `/replay`
endpoint are unchanged.

| Area                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action list**              | Merged action tree with status, params hint, duration, per-action console error/warning badges, keyboard nav. `SearchFilterInput` filters the tree (title + selector/url/expression), keeping ancestors. Group chips (`route`/`getter`/`configuration`) hidden by default via `model.filteredActions([])`, toggled with counts, persisted in localStorage. Groups start **collapsed** except any subtree containing a real action error (chain stays expanded so the red row shows); manual toggles preserved via an XOR `overrides` set; an effect auto-reveals ancestors on external selection.                                      |
| **Snapshot pane**            | Before/Action/After tabs; up to 3 iframes stay mounted + visibility-toggled (instant tab switches). `snapshotInfo/<pageId>` fetched via proxy drives a URL chrome bar + exact `info.viewport` scaling (fixes mid-run `setViewportSize`). "Open in new tab" via `snapshot.html?r=…`; persisted canvas toggle passes `shouldPopulateCanvasFromScreenshot=1`.                                                                                                                                                                                                                                                                             |
| **Timeline / filmstrip**     | Strip spanning `[startTime,endTime]`: screencast JPEGs sampled to width (≤60 thumbs, each proxy-fetched — an `<img>` at the SW path would 404), selected-window overlay, hover time cursor. 8px per-action bars lane (fail red, selected accent). Hover shows a floating screencast-frame preview card (`PREVIEW_HEIGHT` 220, `z-50`, flips below the strip when it would clip the top of the modal).                                                                                                                                                                                                                                  |
| **Playback**                 | Prev / Play-Pause / Stop / Next / speed cluster, semantics reverse-engineered from the vendored 1.61.1 bundle: `rAF` clock advances a playhead by `elapsed × speed` (presets `[0.5,1,2]`), selecting the nearest action as it crosses. Walks `model.filteredActions([])` (default-visible set) so stepping never lands on a hidden noise action with no row.                                                                                                                                                                                                                                                                           |
| **Detail tabs**              | Call (default when no errors: params/return/timing/ANSI error), Log, Errors, Console, Network, Attachments, Metadata — counts on labels. Network rows open a drawer (General / Timing HAR-phase bar / headers / request+response body previews via proxy). A crosshair toggle switches Console/Network from highlight-the-window to FILTER-to-the-window (`eventsForAction` / `_monotonicTime` range). **Copy prompt** button (errors-tab, official 1.51 parity: error + failing action + top frame).                                                                                                                                  |
| **Source tab**               | Content lives at `sha1/src@<SHA-1 of raw stack-frame path>.txt`, proxy-fetched + cached onto `SourceModel.content`. Defaults to selected action's top frame; file-tab picker + right-hand stack-frames pane; target line highlighted + scrolled; error lines get `bg-fail-soft`. Syntax highlighting via pure `@lezer/javascript` + `@lezer/highlight` tokenization (NO `@codemirror/*` imports — CodeMirror was tried and reverted: custom extensions hit "multiple instances of @codemirror/state" under Vite dev pre-bundling). Palette is a scoped `.trace-source` block in `styles.css`. Tab appears only when `model.hasSource`. |
| **Attachments**              | `image/*` render thumbnails (proxy sha1 / base64 data-URL); `text/*` + JSON expand inline (50k cap, pretty JSON); others are download links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Attempt switcher**         | `/replay` returns `attempts: [{attempt, traceViewerUrl, downloadHref}]` (ascending, per-attempt tokens). `SegmentedControl` appears when 2+ attempts exist; switching remounts the viewer on the new trace URL.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Trace token TTL**          | New `TRACE_TOKEN_TTL_SECONDS` (8h vs the 1h default) — the SW range-reads the zip lazily, so a long debugging session would fail mid-scrub on a 1h token. Applied to `type === "trace"` only (replay endpoint + `signArtifactRows`); traces never take the direct-R2 presign path. Chosen over mid-session refresh (a new URL is a different SW cache key → full reload).                                                                                                                                                                                                                                                              |
| **SW pre-warm on hover**     | `warmTraceViewer(traceUrl?)`: no-arg registers the SW (bridge "warm mode"), with-URL prefetches the model into the SW cache. Wired to `ReplayRowButton` pointer-enter (register-only) and the rail's Replay trigger (full prefetch, URL known at SSR).                                                                                                                                                                                                                                                                                                                                                                                 |
| **Bridge error diagnostics** | On load failure the bridge probes the trace URL directly and appends the real HTTP status + hint (404 → "artifact bytes missing… re-run the fixture seed", 401/403 → token expired). Motivated by a real local-dev 404 surfacing as the official viewer's misleading "grant Local Network Access" copy.                                                                                                                                                                                                                                                                                                                                |

## Tests

Test pyramid built out to node lane **397 passed / 4 skipped** (from 291) plus
the e2e contract:

- **Shared fixture** `src/__tests__/trace-viewer-fixture.ts` — a synthetic
  `ContextEntry` with variety for every tab (hooks/api/failing-expect actions, a
  route group, console + pageError events, HAR resources incl. a 500 + postData
  - sha1 body, image/JSON/hidden attachments, stack frames, screencast frames),
    run through the REAL vendored `MultiTraceModel`; `makeBridge()` is a
    path-prefix-keyed `TraceBridge` fake that records calls and 404s on misses.
- **Units** — `trace-viewer-format`, `trace-viewer-model` (snapshot fallback
  walks, URL builders, default selection, version-error copy).
- **Protocol** — `trace-viewer-hooks` (18: full bridge postMessage contract —
  loading→model/error, progress, origin + source-window checks, fetchJson
  round-trip + failure, 30s timeout, unmount rejection/cleanup; security checks
  tested as-is, never weakened), `trace-viewer-warm` (dedupe / src shapes).
- **Components** — `action-list`, `detail-tabs`, `snapshot-pane`, `timeline`,
  `source-tab`, and the detail-tab panels: group chips + localStorage, search +
  ancestors, collapse, keyboard nav; default-tab logic, label counts, hasSource
  gating, scope-toggle; Call params/result/error, Copy-prompt clipboard + flip;
  console ANSI-strip + scope filter, network drawer sections + body preview via
  the bridge fake + fail-status styling, attachment visibility/expansion;
  snapshot tab derivation + URL bar + canvas toggle + popout href; timeline bars,
  proxy thumbs, click-to-seek math, zero-duration null render.
- **Guards** — `trace-viewer-vendor` (drift vs installed playwright-core),
  `token-conventions` (design-token rules across all viewer files).
- **E2E** — `test-replay.spec.ts` (3): real trace through the real SW — headers
  (`sw.bundle.js` + `bridge.html` + `index.html`), action list populated,
  snapshot iframes served, deep link, Escape, rail flow, Call tab + searchbox.

happy-dom shims used by component suites (local per file, restored):
ResizeObserver stub, clientWidth/Height + getBoundingClientRect spies,
URL.createObjectURL/revokeObjectURL (saved with `.bind(URL)` to satisfy the
`unbound-method` lint), `getAnimations`, `scrollIntoView` no-op.

## Verification

- **Static:** `pnpm check` → 0 errors, 133-warning repo baseline (vendored files
  contribute none — scoped `oxlint-disable` headers for upstream naming).
- **Unit:** node lane 397 passed / 4 skipped; workers lane 1222 passed.
- **Real browser, real traces** (dev server + seeded fixtures, Chromium, dark
  mode, screenshotted): action list renders the merged model with the failed
  `expect` auto-selected; SW-served snapshot document renders the actual DOM;
  attempt switcher swaps traces; filmstrip shows proxy-fetched blob thumbs;
  Source tab renders the real spec with the failing line highlighted +
  `tok-*` syntax spans; attachments show inline previews; playback advances the
  selection and cycles speed; hooks groups start collapsed with the failing row
  visible; hover preview renders fully inside the dialog; scope toggle filters
  Console; Escape closes the modal and clears `?replay=`.
- **Isolated dashboard e2e:** `pnpm --filter @wrightful/e2e test:dashboard
test-replay.spec.ts` → 3/3 (fresh `_e2e` DB on :5189, fixtures from real
  Playwright runs; boot needs `DATABASE_URL` exported so the fixture writes it
  into the generated `.env.local`).

## Deliberate scope cuts / known gaps

- **No pick-locator / inspect mode** — requires Playwright's
  `InjectedScript`/`Recorder` bundle, which ships only inside the minified
  official UI chunk; no reuse seam.
- **Network drawer never driven against a real network-bearing trace** — every
  seeded fixture uses `setContent` (zero HAR entries); component tests cover it.
  Follow-up: add a fixture spec doing a real `page.goto` + `fetch`.
- **Server-side step extraction at ingest** — scoped separately in
  `docs/step-extraction-plan.md` (touches ingest + schema; ships on its own).
- `bridge.html`'s inline script and `split-pane.tsx` drag math are exercised
  only via e2e (inline-by-design document; no layout in happy-dom).
- Showing a noise group via its chip doesn't add it to the playable set (chip
  state lives in `ActionList`); Pause→Play resumes from the selected action's
  startTime, not the exact paused timestamp. Both deferred as imperceptible.
- The `/trace-viewer/*` CSP carve-out is unchanged; once the official-viewer
  fallback is retired, `unsafe-eval` can likely be dropped.
