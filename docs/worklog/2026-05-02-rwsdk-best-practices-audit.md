# 2026-05-02 — rwsdk best-practices audit

## What changed

Audited the dashboard against the official rwsdk docs (`/websites/rwsdk` via Context7) covering routing, middleware/interruptors, RSC, Document/layouts, security headers, env access, Database DSL, and the SyncedState DO. The dashboard already follows rwsdk conventions tightly — branded auth IDs, `SqliteDurableObject` extension, `prefix()` + `render()` + `layout()` composition, `setCommonHeaders` with CSP nonce, etc. Three small gaps were closed:

1. **Top-level page error handler.** Added `except()` from `rwsdk/router` inside `render(Document, …)` so unhandled exceptions in page routes/middleware/RSC actions render a themed `<ErrorPage>` instead of leaking a stack trace through Cloudflare's default 500. API errors (under `prefix("/api", …)`) are unaffected — they continue to bubble through their existing handler-level `Response` returns.
2. **Hoisted `requireUser`.** The `[requireUser, …]` interrupter was repeated on 16 routes inside `layout(AppLayout, [...])`. Replaced with a single `requireUser` entry at the top of the layout body — rwsdk docs state middleware in a route array applies to all subsequent routes in that array. Side effect: `route("/settings", settingsRootRedirect)`, which previously redirected without auth, now requires auth before redirecting, which is the desired behavior.
3. **CSP / clickjacking hardening.** `frame-ancestors` was `'self'`; tightened to `'none'` (the dashboard isn't framed by anyone). Added `X-Frame-Options: DENY` belt-and-braces for older clients.

## Details

| File                                                           | Change                                                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/worker.tsx`                            | Import `except` from `rwsdk/router` + `ErrorPage`. Add `except()` inside `render(Document, …)`. Hoist `requireUser` to top of `layout(AppLayout, …)` body and remove per-route copies. |
| `packages/dashboard/src/app/components/error-page.tsx` _(new)_ | Minimal RSC error component matching the dashboard's Tailwind theme.                                                                                                                   |
| `packages/dashboard/src/app/headers.ts`                        | `frame-ancestors 'self'` → `'none'`; added `X-Frame-Options: DENY`.                                                                                                                    |

## Out of scope (deferred)

- Migrating POST handlers (e.g., `createTeamHandler`, `teamDetailHandler`) to rwsdk's `serverAction` from `"use server"` files. Existing pattern is fine; revisit if/when forms grow more interactive.
- Switching short-circuit middleware (`requireUser` redirect) to `throw new ErrorResponse(...)`. Both work; `Response.redirect` is what's there.
- Tightening `style-src 'self' 'unsafe-inline'` — Tailwind v4's runtime-injected styles likely rely on inline styles.

## Verification

- `pnpm typecheck` — clean (dashboard + reporter).
- `pnpm lint` — 0 errors (30 pre-existing warnings, none introduced by this change).
- `pnpm --filter @wrightful/dashboard test` — 167 tests passed.
- Manual smoke deferred to user's `pnpm dev`:
  - Logged-out `/` → still redirects to `/login`.
  - Logged-in `/settings/...`, `/t/.../runs/...` → still load.
  - `/api/runs` without auth → still 401.
  - Response headers should now show `frame-ancestors 'none'` in CSP and `X-Frame-Options: DENY`.
