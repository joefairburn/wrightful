# 2026-05-24 — Void error pages (404 / 500) + artifact 401 HTML

## What changed

Added user-facing error pages for the Void dashboard (`packages/dashboard-void/`):

- **404** — regular `pages/not-found.tsx` + colocated loader that sets
  `c.status(404)`. Wired up two ways:
  - `routing.fallbacks` in `void.json` rewrites any unmatched URL here at
    the edge layer (only fires when no route AND no static asset matched).
  - `middleware/00.errors.ts` rewrites here for downstream-thrown 404s.

  Initially tried a catch-all `pages/[...notFound].tsx`, but the resulting
  `:notFound{.+}` Hono pattern matches Vite's dev source-file URLs
  (`/pages/.../index.tsx`) too — those returned text/html and broke dynamic
  imports / HMR. `routing.fallbacks` doesn't have this problem because it
  runs at the edge dispatch layer, after the worker returns no-route 404,
  not as a Hono route.

- **500** — `pages/oops.tsx` + loader that sets `c.status(500)`. Reached
  via `c.rewrite("/oops")` from the new error middleware.
- **Error middleware** — `middleware/00.errors.ts` covers two distinct
  error paths because Hono handles them differently:
  - **Thrown `Response`** (existing loader convention,
    `throw new Response("Not Found", { status: 404 })`) bubbles past
    Hono's `compose` because `Response` is not an `Error`. A try/catch
    around `next()` catches it.
  - **Thrown `HTTPException`** (e.g. `requireAuth(c)` from `void/auth`
    throws `HTTPException(401)`) IS an `Error`, so Hono's `compose`
    converts it to a `Response` via the framework's default error handler
    BEFORE unwinding `next()`. The try/catch never sees it. The
    middleware inspects `c.res.status` AFTER `await next()` returns and
    rewrites/redirects from there.
  - Behavior:
    - `/api/*` paths pass through so reporters + trace viewer keep
      machine-readable errors.
    - Already on `/oops` or `/__not-found` → pass through (no loops).
    - **401** → `c.redirect("/login")`.
    - **404** → `c.rewrite("/__not-found")` (falls through to the
      catch-all `[...notFound]`).
    - **5xx / uncaught** → `logger.error(...)` via `void/log` and
      `c.rewrite("/oops")`.
- **Artifact download 401** — `routes/api/artifacts/[id]/download.ts`
  previously returned `"Unauthorized"` as plain text when the HMAC token
  was missing/expired. Now returns a self-contained styled HTML page
  (status 401) when the request includes `Accept: text/html` (direct
  browser navigation); `<img>`/`<video>`/fetch clients still get the plain
  text 401 so on-the-wire error handling stays predictable.

## Why

- The previous behavior surfaced raw Hono fallbacks ("Not Found",
  "Unauthorized", "Internal Server Error") for any unmatched URL, loader
  throw, or expired artifact link, which looked broken to end users.
- Picking middleware + `c.rewrite()` (rather than per-route try/catch or
  inline HTML) means the error pages flow through the normal Void
  pipeline — Inertia-style navigation, asset hashing, CSS bundle — so
  they match the rest of the dashboard automatically.
- The artifact 401 has no useful redirect target (it's token-authed,
  unrelated to user session), so inline HTML is the simplest UX win that
  doesn't break the `<img>`/trace-viewer contract.

## Files

| File                                    | Change                                  |
| --------------------------------------- | --------------------------------------- |
| `pages/[...notFound].tsx`               | New — styled 404 component              |
| `pages/[...notFound].server.ts`         | New — loader sets status 404            |
| `pages/oops.tsx`                        | New — styled 500 component              |
| `pages/oops.server.ts`                  | New — loader sets status 500            |
| `middleware/00.errors.ts`               | New — global error gate                 |
| `routes/api/artifacts/[id]/download.ts` | Returns HTML 401 for browser navigation |

## Notes for future work

- Existing loaders use `throw new Response("Not Found", { status: 404 })`
  for missing tenants/projects/runs — these now flow through the new
  middleware and render the styled 404 instead of plain text. No
  per-loader changes were needed.
- The catch-all `pages/[...notFound]` only fires for unmatched **page**
  URLs. Missing `/api/*` endpoints still get the default Hono 404, which
  is correct for programmatic clients.
- `middleware/00.errors.ts` runs before `01.context.ts` and `02.api-auth.ts`
  so it catches throws from both.

## Verification

- `pnpm exec tsgo --noEmit` — passes (exit 0).
- `pnpm exec vp check --no-fmt` — no new errors/warnings in the touched
  files. Pre-existing warnings in `pages/insights/*`, `auth.ts`,
  `slider.tsx`, etc. are unchanged.
- `pnpm exec vp fmt --write` applied to all new files.
- `pnpm exec void prepare` regenerated `.void/` codegen successfully.
- Manual smoke (dev server is the user's to run): navigate to an unknown
  URL → 404 page; trigger a loader throw → 500 page via `/oops`; visit a
  stale artifact link in a new tab → "Artifact link expired" HTML.
