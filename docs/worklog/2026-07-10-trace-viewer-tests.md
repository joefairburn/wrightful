# 2026-07-10 — Trace viewer: extensive test coverage

## What changed

Built out the trace viewer's test pyramid (phases 1–3 shipped with contract

- e2e coverage but almost no component coverage). Nine new node-lane suites
  plus a shared fixture; node lane grew 291 → 375 tests.

**Shared fixture** (`src/__tests__/trace-viewer-fixture.ts`, not a test
file): a synthetic `ContextEntry` mirroring the `contexts?trace=` JSON with
enough variety for every tab (hooks/api/failing-expect actions, a
route-grouped action, console log/error + pageError events, two HAR
resources incl. a 500 + postData + sha1 body, image/JSON/hidden
attachments, stack frames, screencast frames), `makeModel()` running it
through the REAL vendored `MultiTraceModel`, and `makeBridge()` — a
`TraceBridge` fake keyed by path prefix that records calls and 404s on
misses.

## Coverage map

| Layer        | Suites                                                                                                  | What's pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure units   | `trace-viewer-format` (12), `trace-viewer-model` (11)                                                   | byte/offset formatting; snapshot fallback walks, URL builders, default selection, version-error copy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Protocol     | `trace-viewer-hooks` (18), `trace-viewer-warm` (4)                                                      | the FULL bridge postMessage contract — loading→model/error, progress, origin + source-window checks (happy-dom supports `event.source === iframe.contentWindow`), fetchJson round-trip incl. failure, 30s timeout, unmount rejection + iframe cleanup; warm dedupe/src shapes. The hook's security checks were tested as-is, never weakened.                                                                                                                                                                                                                                                                                                         |
| Components   | `action-list` (13), `detail-tabs` (8), `tabs-a` (7), `tabs-b` (12), `snapshot-pane` (6), `timeline` (4) | group chips + localStorage, search incl. ancestors, collapse, keyboard nav, aria-selected; default-tab logic, label counts, hasSource gating, scope-toggle scoping; Call params/result/error, Copy-prompt clipboard text + "Copied" flip, action-jump; console ANSI-strip + scope filtering, network drawer sections + body preview via the bridge fake + fail-status styling, attachment visibility/expansion/preview; snapshot tab derivation + pointX/pointY + URL bar + canvas-toggle param/persistence + popout href + empty state; timeline bars (fail/selected classes), bridge-fetched thumbs, click-to-seek math, zero-duration null render |
| Guards       | `trace-viewer-vendor` (1), `token-conventions`                                                          | vendor-sync drift vs installed playwright-core; design-token rules across all viewer files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E2E contract | `test-replay.spec.ts` (3)                                                                               | real trace through the real SW: headers, action list populated, snapshot iframes served, deep link, Escape, rail flow — now also asserts the Call tab + action searchbox render                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

happy-dom environment shims used by the component suites (local per file,
restored): ResizeObserver (immediate-callback stub), clientWidth/Height +
getBoundingClientRect spies (no layout in happy-dom), URL.createObjectURL /
revokeObjectURL (saved with `.bind(URL)` — unbound saves trip the
`unbound-method` type-aware lint), `Element.prototype.getAnimations` (Base
UI ScrollArea polls it from a timer), scrollIntoView no-op.

## Honest gaps (known, deliberate)

- `bridge.html`'s inline script (SW registration, fetch-proxy dispatch,
  error probing) is exercised only via the e2e suite — it's an inline
  document by design (a controlled client must not load subresources).
- `split-pane.tsx` drag math is untested (happy-dom has no layout; the e2e
  suite renders it but doesn't drag).
- The network detail drawer has never been driven against a REAL
  network-bearing trace — every seeded fixture spec uses `setContent`
  (zero HAR entries). Follow-up: add one fixture spec doing a real
  `page.goto` + `fetch` so e2e traces carry network entries.

## Verification

- Node lane: **375 passed / 4 skipped** (was 291); workers lane 1222
  passed; `pnpm check` 0 errors at the 133-warning repo baseline (six
  `unbound-method` errors in the new suites were caught by the repo-wide
  check and fixed with `.bind(URL)`).
- Isolated dashboard e2e `test-replay.spec.ts` → 3/3 including the new
  Call-tab/searchbox assertions.
