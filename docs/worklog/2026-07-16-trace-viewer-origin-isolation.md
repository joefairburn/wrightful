# 2026-07-16 — Trace-viewer origin isolation (snapshot XSS hardening)

## What changed

A HIGH security finding: the embedded Test Replay viewer rendered DOM-snapshot
documents in an iframe with `sandbox="allow-same-origin allow-scripts"` whose
`src` pointed at the dashboard's OWN origin (`/trace-viewer/snapshot/<pageId>`).
Per the HTML spec, `allow-same-origin` + `allow-scripts` on a **same-origin**
document neutralises the sandbox entirely — the snapshot document runs with full
access to the dashboard origin (session cookies, parent DOM). Snapshot content
comes from bytes inside a trace zip uploaded with a project ingest API key, so
**any key holder can craft arbitrary bytes** — it need not come from Playwright's
real capture pipeline. The only barrier was the vendored Playwright service-worker
renderer (`sw.bundle.js`) stripping `<script>` nodes / `on*` attributes: a single
sanitiser SPOF whose failure is stored XSS → dashboard session takeover when a
teammate clicks Replay. Upstream Playwright deliberately isolates this surface
onto a separate origin (`trace.playwright.dev` / unique localhost ports).

This change:

1. **Makes a separate, cookieless trace-viewer origin configurable** (code-side
   support; the DNS/routing half is a documented manual deploy step).
2. **Fixes the actual bug regardless of origin** — the same-origin default no
   longer combines `allow-same-origin` with `allow-scripts`, and adds a
   `script-src 'none'` CSP on `/trace-viewer/snapshot/*`.
3. **Marks `playwright-core` as a security-relevant pin** because the SW
   sanitiser is load-bearing.

The **default (same-origin) deployment is now safe with no configuration**; the
cost is snapshot fidelity (scroll/canvas/point-marker scripts don't run — static
DOM still renders). A configured separate origin restores full fidelity safely.

## Details

### New single source of truth

- `apps/dashboard/src/trace-viewer/origin.ts` (new). Reads the build-time
  `import.meta.env.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` (literal member access so
  Vite inlines it in **both** the client and worker bundles). Exports:
  - `traceViewerOrigin()` / `isSeparateTraceViewerOrigin()` — `""` (same-origin)
    by default; trailing slash stripped.
  - `traceViewerScopeUrl()` — origin-aware `${origin}/trace-viewer/` prefix.
  - `traceViewerBridgeOrigin(pageOrigin)` — the exact origin the parent must
    target/accept postMessages from (never a wildcard). Pure (takes
    `pageOrigin`) for testability.
  - `snapshotSandbox()` — `"allow-same-origin"` (same-origin default, scripts
    OFF) vs `"allow-same-origin allow-scripts"` (separate cookieless origin,
    scripts safe). `allow-same-origin` is always required (the SW only controls
    same-origin clients; the parent binds Escape across the frame's document).

### Origin-aware URLs

- `model.ts` — `snapshotIframeUrl` / `snapshotPopoutUrl` / `sha1DownloadUrl`
  now build off `traceViewerScopeUrl()` (relative same-origin by default,
  absolute at the configured origin otherwise). The bridge-proxy paths
  (`snapshotInfoPath`, `sha1Path`) stay **relative** — they resolve inside the
  bridge document, which is already on the right origin. `TRACE_VIEWER_SCOPE`
  moved to `origin.ts` (re-exported from `model.ts` for existing importers).
- `bridge-iframe.ts` — `BRIDGE_PATH` is origin-aware; new `bridgeIframeSrc()`
  appends `host=<parent-origin>` so a cross-origin bridge can target its
  postMessages back at exactly the dashboard and reject anything else.

### Explicit (non-wildcard) postMessage origin checks

- `bridge.html` — resolves `HOST` from the `host` param (falls back to
  `location.origin`, and to `location.origin` on a malformed value); `send()`
  now targets `HOST`, and the inbound listener accepts only `event.origin ===
HOST`. The fetch-proxy still validates against `location.origin` (the bridge's
  own = trace-viewer origin) and `url.pathname.startsWith("/trace-viewer/")`, so
  it stays within scope in both modes.
- `use-trace-model.ts` / `warm.ts` — the parent now sends to and accepts from
  `traceViewerBridgeOrigin(window.location.origin)` instead of assuming
  same-origin.

### Defense-in-depth (the bug fix)

- `components/snapshot-stage.tsx` — the snapshot iframe `sandbox` is now
  `snapshotSandbox()` (drops `allow-scripts` same-origin).
- `middleware/00.defensive-headers.ts` — new
  `TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY` (`script-src 'none'`) applied
  to `/trace-viewer/snapshot/*` in same-origin mode (skipped when a separate
  origin is configured, where snapshots are cross-origin/script-safe and served
  by the trace-viewer origin's own edge CSP). The general `/trace-viewer/*`
  policy is unchanged (bridge/SW/runtime still need scripts).

### Config + docs

- `env.ts` — declares `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` (`url().optional()`,
  `VITE_`-prefixed → client-exposed; it's an origin, not a secret).
  `src/vite-env.d.ts` types it on `ImportMetaEnv`.
- `scripts/sync-trace-vendor.mjs` — a prominent ⚠️ SECURITY note: `playwright-core`
  bumps are security-sensitive because `sw.bundle.js` is the snapshot sanitiser;
  any bump touching the snapshot pipeline must be reviewed as a security change.
- `SELF-HOSTING.md` — a "Trace-viewer origin isolation" section (DNS/routing +
  `frame-ancestors` + verification steps) and a build-time variable table row.

## Why "separate origin" isn't fully wired here

A cookieless-subdomain deploy needs a Cloudflare custom-domain/route bound to the
same Worker plus a cross-origin `frame-ancestors` allowance — DNS/edge config that
**cannot be provisioned or verified in this sandbox**. So the code supports it
behind one build-time env var with a **safe same-origin default**, and the manual
steps are documented in SELF-HOSTING.md. The dashboard-side worker keeps
`frame-ancestors 'self'`; the cross-origin embed allowance is a deploy-side header
the operator sets on the trace-viewer origin.

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run` on the trace-viewer +
  defensive-headers suites — **all 24 trace-viewer files green (293 tests)**,
  plus the new `trace-viewer-origin.test.ts` (same-origin vs separate-origin URL
  builders, sandbox, bridge handshake) and extended `defensive-headers-config`
  (snapshot CSP forbids scripts). Updated `trace-viewer-warm` / `trace-viewer-hooks`
  bridge-src assertions to the new `host=` shape.
- `tsgo --noEmit` — clean for every file this change touches (the 10 remaining
  errors are pre-existing in `usage-atomic.test.ts` / `pg-integration/invites.test.ts`,
  untouched here).

## Residual risk / follow-ups (needs manual verification)

- **Separate-origin path is untested end-to-end in-sandbox.** The cross-origin
  postMessage handshake, SW registration on the second origin, and the
  `frame-ancestors` embed allowance need a real two-hostname deploy to verify
  (steps in SELF-HOSTING.md).
- **SW-served snapshot CSP is unchanged.** In normal operation the Playwright
  service worker answers snapshot navigations and sets its own weaker
  (`upgrade-insecure-requests`) meta CSP that the worker header can't override —
  which is exactly why the browser-enforced `sandbox` (dropping `allow-scripts`)
  is the primary control and the worker CSP is defense-in-depth for the
  worker-served path.
- **Standalone popout / full-viewer links remain same-origin by default.**
  `snapshotPopoutUrl` now routes through the configured origin, but
  `selfHostedTraceViewerUrl` (`src/lib/artifact-tokens.ts`, used by the artifacts
  rail + MCP `get_artifact`) still points at the dashboard origin — a top-level
  user-initiated navigation, not an embedded sandbox, so the neutralised-sandbox
  bug doesn't apply; routing it through the cookieless origin too is a small
  follow-up left out to keep artifact-token core edits minimal.
- **Same-origin fidelity trade-off.** Snapshot scripts (scroll/canvas/point
  marker) don't run in the default config. This is the sanctioned safe default;
  configure a separate origin to restore them.
