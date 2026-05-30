# 2026-05-30 — Record that `script-src 'unsafe-inline'` is load-bearing (CSP is not the ansi-XSS backstop)

## What changed

Made the relationship between the dashboard's CSP and its lone untrusted-text →
`dangerouslySetInnerHTML` sink an **explicit, recorded decision** instead of an
accidental migration regression (finding F89, origin-safety cluster).

No behaviour changed. The FOUC-killer theme-init inline script that
`middleware/01.head.ts` injects was extracted into a small documented seam,
`apps/dashboard/src/lib/theme-init-script.ts`, whose doc comment is now the
single place that records _why_ `void.json` runs `script-src 'self'
'unsafe-inline'` and what that means for XSS containment. A unit test pins the
script's invariants.

This implements path (b) of F89. Path (a) — restoring the pre-Void nonce-based
CSP — was investigated and found **not currently feasible on Void** (see below),
so it is deferred with a recorded re-entry condition rather than attempted.

## Why path (a) (nonce-CSP restoration) is not feasible right now

The pre-Void rwsdk stack ran a nonce-based CSP (`setCommonHeaders` with a
per-request CSP nonce — worklog `2026-05-02-rwsdk-best-practices-audit.md`).
That seam was lost in the Void migration; the MVP review
(`docs/reviews/2026-05-29-mvp-review.md:200`) flags the security headers as
"lost in the migration" and treats CSP generically as "the XSS containment
layer." CSP was since restored in `void.json`, but as `script-src 'self'
'unsafe-inline'`.

Restoring the _nonce_ form requires tagging every inline `<script>` with a
per-request nonce. Reading Void 0.8.9's runtime shows the framework itself emits
executable inline scripts during SSR with **no nonce hook**:

| Inline script source                                                                        | Where                                                         | Nonce-able?                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| FOUC-killer theme init                                                                      | `middleware/01.head.ts` via `headDefaults.script[].innerHTML` | yes (head serializer renders extra script attrs)  |
| Deferred-prop resolution (`window.__resolveDeferred(...)` / `window.__rejectDeferred(...)`) | Void page protocol streaming (`void/dist/pages/protocol.mjs`) | **no** — framework-controlled, no nonce parameter |
| `__VOID_PAGE_DATA__` hydration data                                                         | `@void/react` `pages-server.mjs`                              | n/a — `type="application/json"`, not executed     |

Void's only nonce machinery (`adjustDevCssCsp` in `protocol.mjs`) touches
`style-src`/`style-src-elem` for dev-injected CSS only — it never threads a
nonce into `script-src`. So a strict `script-src 'self' 'nonce-…'` would break
hydration on any page that streams deferred props. Forking the framework is out
of scope. `'unsafe-inline'` is therefore intentionally load-bearing for
`script-src` (and separately for `style-src`, per Tailwind v4 runtime styles).

## The recorded consequence

Because `script-src 'unsafe-inline'` is on, **CSP does not contain inline-script
/ event-handler XSS** at the dashboard's only `dangerouslySetInnerHTML` sink:
`ansiToHtml` (`src/lib/ansi.ts`) rendered by `src/components/test-error-alert.tsx`,
fed attacker-controlled Playwright `errorMessage` / `errorStack` via the ingest
pipeline. The ansi sanitiser is the **sole** XSS guarantee for that path — CSP is
not a second layer. That contract is pinned by `src/__tests__/ansi.test.ts`
(finding F88); this worklog records that those tests are load-bearing precisely
because CSP cannot catch a regression there.

Re-entry condition: if Void exposes a per-request script nonce, thread it through
`themeInitScript`'s injection point and drop `'unsafe-inline'` from `script-src`
in `void.json`; CSP then becomes a real backstop and `theme-init-script.ts`'s
comment should be revised.

## Code changes

| File                                                             | Change                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/theme-init-script.ts` _(new)_            | Pure seam: exports `themeInitScript` (the FOUC-killer body) + the recorded `'unsafe-inline'` / ansi-sink rationale.    |
| `apps/dashboard/middleware/01.head.ts`                           | Import `themeInitScript` instead of inlining the literal; doc comment points at the seam for the CSP rationale.        |
| `apps/dashboard/src/__tests__/theme-init-script.test.ts` _(new)_ | Pins the script invariants (toggles `.dark`, try/catch, contains no `<`, no event-handler/external-load/eval surface). |

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/theme-init-script.test.ts src/__tests__/ansi.test.ts` — passing.
- No behaviour change: the injected inline script body is byte-identical to the
  previous literal (verified by string equality during extraction).
