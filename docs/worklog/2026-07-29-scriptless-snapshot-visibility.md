# 2026-07-29 — Script-less trace snapshots rendered a blank pane

## What changed

Same-origin trace replay rendered a **fully blank white snapshot pane**. The
timeline, action list, network/console/source tabs and screenshots all worked;
only the DOM snapshot iframe was empty. Fixed by lifting Playwright's snapshot
visibility guard from the parent frame when the snapshot iframe runs without
`allow-scripts`.

## Root cause

`bb7897c` ("Harden platform boundaries and background workflows", #58) replaced
the snapshot iframe's hardcoded `sandbox="allow-same-origin allow-scripts"` with
`snapshotSandbox(pageOrigin)`, which drops `allow-scripts` unless
`VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` configures a separate cookieless viewer
origin. That hardening is correct and stays — uploaded trace bytes are
attacker-craftable, so snapshot script under the session origin is stored XSS.

What it missed is that Playwright's snapshot renderer emits every snapshot as:

```
<!DOCTYPE …><style>*,*::before,*::after { visibility: hidden }</style><script>…</script>…
```

The guard stylesheet hides the entire document so the raw serialized DOM never
flashes before the inline bootstrap has applied its fixups. On `load` the
bootstrap restores scroll offsets, then runs
`document.styleSheets[0].disabled = true`, then builds the click marker and
repaints canvases (the guard is lifted mid-handler, not last — worth knowing
when re-deriving this against a future version). Block the script and nothing
ever lifts the guard, so **every element stays `visibility: hidden`** — a blank
white frame, not the "reduced fidelity" the isolation trade-off was documented
to cost.

The non-snapshot panes were unaffected because they render from the parsed trace
model in the dashboard's own React tree, never from the iframe. That split is
what made this read like a network/CORS/token problem rather than a rendering
one.

## Fix

- **`src/trace-viewer/components/scriptless-snapshot.ts`** (new) —
  `prepareScriptlessSnapshot(win)` applies the two fixups a script-less snapshot
  needs. It removes the guard `<style>`, matching only the first `<style>` in
  the document and only on exact text (the same "it is `styleSheets[0]`"
  assumption Playwright's own bootstrap makes), and it installs a capturing
  `click` listener that `preventDefault`s navigation. The frame is
  `allow-same-origin`, so its document is reachable from the parent; no snapshot
  code executes.
- **`src/trace-viewer/components/snapshot-stage.tsx`** — `SnapshotFrame`'s
  `onLoad` calls it when `!snapshotScriptsEnabled(pageOrigin)`, _after_ the
  escape binding and the back-buffer promotion hook. The separate-origin path is
  untouched: the snapshot's own script still does this.
- **`src/trace-viewer/origin.ts`** — `snapshotScriptsEnabled()` is now the one
  predicate behind the sandbox attribute, the script-less fixup gate, and the
  popout control, so the three cannot drift apart.

**Why the click suppression is not scope creep.** The guard did two jobs:
`visibility: hidden` is not hit-testable, so while it was up the snapshot was
inert. Lifting it makes the captured DOM live — and the serializer rewrites
`src` but deliberately never rewrites `href`, which is why Playwright's own
bootstrap pairs the guard lift with `preventDefault` on every `<a>`. Without it,
one click inside a replay navigates the iframe to the original live URL; frames
are keyed by URL so React never remounts, and the snapshot is unrecoverable
until the user scrubs away and back. Measured alternative: `inert` on the frame
also blocks clicks, but it blocks _scrolling into the frame_ too — and scrolling
is the only way left to see below the fold once scroll restoration is gone.

**Hostile input.** Snapshot documents are attacker-craftable and `Document` has
`[LegacyOverrideBuiltIns]`, so an `<img name="querySelector">` in the captured
page shadows the real method (`name` survives the serializer, which strips only
`<script>` and `on*`). Confirmed in Chromium that both `doc.querySelector` and
`doc.addEventListener` clobber this way. Every DOM call therefore goes through
`win.Document.prototype` / `win.EventTarget.prototype`, which named properties
cannot shadow, and the whole reach-in is wrapped in `try`/`catch` — a frame that
navigated itself is cross-origin, and reading `win.document` throws
`SecurityError` on the next `load`.

Still deliberately out of scope: the rest of the bootstrap (scroll offsets,
input values, shadow roots, nested-frame `src`, canvas contents, click marker).
Reimplementing those in the parent would be a standing maintenance burden
against Playwright internals for a mode that is explicitly the reduced-fidelity
fallback.

## Popout

The **"open snapshot in a new tab"** control is now hidden in same-origin mode
(`snapshot-pane.tsx`). It renders through Playwright's vendored `snapshot.html`,
whose iframe hardcodes `sandbox="allow-same-origin allow-scripts"` — we cannot
drop the flag there the way `snapshotSandbox` does for the embedded pane, and
its path (`/trace-viewer/snapshot.html`) does not match the middleware's
`/trace-viewer/snapshot/` prefix. Same-origin, that executed attacker-craftable
snapshot HTML against the session cookies: the exact stored-XSS path the
isolation model exists to close. Unrelated to the blank pane — the popout was
full-fidelity precisely _because_ its bootstrap ran — but found while
documenting the fix, and left unfixed it made the surrounding docs false.

## Verification

Reproduced and verified against a live own-account deployment
(`workers.dev`, same-origin, no `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN`) driving a
real 8.4 MB trace through the real service worker in headless Chromium.

- Isolation: identical snapshot URL, same SW, only `sandbox` differing —
  no sandbox → 1294 chars of body text; `allow-same-origin` → **0**;
  `allow-same-origin allow-scripts` → 1294. Computed style inside the blank
  frame: `body` and all children `visibility: hidden`.
- Fix: the **bundled shipped module** run against the live Before/Action/After
  triple, with `sandbox="allow-same-origin"` — all three go 0 → 1294 chars,
  `body.visibility` `hidden → visible`, and the browser still reports
  `Blocked script execution` for each, i.e. the hardening held.
- Ruled out on the way: artifact download (`200`, worker-proxied, correct CORS,
  token valid), direct-R2/bucket CORS (not enabled there), and the SW itself —
  the vendored stock Playwright viewer at `/trace-viewer/` renders the same
  trace on the same deployment, because it uses `allow-scripts`.

Tests, in three layers — the original bug was invisible to all of them, so each
closes a different escape route:

- `trace-viewer-scriptless-snapshot.test.ts` (new) — guard removal, navigation
  suppression, idempotence, non-guard first `<style>` left alone, no-stylesheet,
  plus the two hostile cases (clobbered `querySelector`/`addEventListener`, and
  a `win.document` that throws). Mutation-checked: reverting to the naive
  `doc.querySelector` fails the clobber case, and dropping the click listener
  fails two others.
- `trace-viewer-vendor.test.ts` — the drift canary now asserts the guard is
  emitted **first** (`["<style>…</style>",` in the render concatenation), not
  merely present. A bump that kept the literal but emitted anything ahead of it
  would leave a text-only check green while every replay went blank.
- `packages/e2e/tests-dashboard/test-replay.spec.ts` — the replay spec asserted
  only the iframe's `src`, which is why a 100%-blank pane shipped. It now
  asserts the snapshot body is actually `visibility: visible`.

`scripts/vendor-trace-viewer.mjs` runs the same guard check at **build** time,
reading the literal back out of `scriptless-snapshot.ts` so there is one copy.
`deploy:cf` runs that script but not the test suite, so a self-hoster would
otherwise still have shipped the blank pane silently. Confirmed to fail with the
remediation message when the constant is perturbed.

Ran: the focused trace-viewer suites, the full dashboard unit suite, and
`pnpm check`. Not run: the dashboard Playwright suite (needs a booted
deployment) — the new e2e assertion is unexercised here.

## Docs

`SELF-HOSTING.md` claimed the same-origin default cost only fidelity and that
"the static DOM still renders". That was false as written — it rendered nothing.
Two further corrections to the same paragraph:

- It credited a `script-src 'none'` CSP on `/trace-viewer/snapshot/*` as a
  second layer. That layer does not reach the snapshot document: Playwright's
  service worker synthesises the response locally (`new Response(html, …)`) and
  even stamps its own `upgrade-insecure-requests`, so the request never
  traverses the worker middleware. The missing `allow-scripts` flag is the sole
  enforcing control, and the docs now say so.
- The fidelity list was incomplete. Added constructed (adopted) stylesheets,
  custom-element registration, open `<dialog>`/popover state, and the
  acted-element highlight.

`docs/worklog/2026-07-20-architecture-review-consolidated.md` restated both
disproved claims as the sanctioning record for the hardening; annotated in place
with a pointer here.
