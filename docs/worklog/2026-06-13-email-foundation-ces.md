# 2026-06-13 — Email sending foundation (Cloudflare Email Service)

## What changed

Stood up the **transport foundation** for outbound email, so later work can
wire up (a) auth verification + password reset and (b) monitor-down alerts.
This is **Phase 0 only** — the binding, env var, send helper, and template
rendering. It deliberately does **not** touch `auth.ts`
(`requireEmailVerification` stays `false`) or the monitoring pipeline; nothing
calls `sendEmail` on a critical path yet.

We use **Cloudflare Email Service (CES)** — the native `send_email` worker
binding — over an HTTP provider (Resend etc.). Rationale: the whole app already
runs on Cloudflare/Void, so there's no new vendor and **no API key to manage or
leak** (the binding model); CES auto-configures SPF/DKIM/DMARC on the sending
domain, which is the part self-hosters usually get wrong. Trade-off accepted:
CES Email Sending is in **public beta** and needs a **Workers Paid** plan. To
hedge the beta risk, every send goes through one `sendEmail()` seam in
`src/lib/email.ts`, so swapping to a `fetch`-based provider later is a
single-file change.

Uses the **structured send API** `env.EMAIL.send({ from, to, subject, html,
text })` → `{ messageId }` (no `cloudflare:email`/`mimetext` MIME-building).
Verified this shape is accepted by **both** the Miniflare local simulator
(`miniflare@4`'s `send_email.worker.js` handles the "MessageBuilder" form,
logging the message + writing the html/text bodies to a temp dir) **and** CES
in production.

## Details

| Area       | Change                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding    | `wrangler.jsonc`: added `"send_email": [{ "name": "EMAIL" }]`. No `"remote": true` — local dev stays simulated (no real sends, no creds). Confirmed it merges into the generated worker manifest (`dist/ssr/wrangler.json`) alongside the existing `ratelimits`.                                                                |
| Env        | `env.ts`: added `EMAIL_FROM` (`string().optional()`, server-only). Optional so self-hosters without CES can still `void deploy`. Documented in `.env.example`.                                                                                                                                                                  |
| Transport  | `src/lib/email.ts`: `sendEmail()` → `SendEmailResult` (`{ sent: true, messageId }` \| `{ sent: false, reason: "not_configured" }`) — graceful skip when email isn't set up, **no throw**; pure `deliverEmail(binding, from, params)` core (logs+rethrows on transport failure); `isEmailConfigured()`, `resolveEmailBinding()`. |
| Templating | `src/lib/render-email.tsx`: `renderEmail(element)` → `{ html, text }` via `@react-email/components`' `render` (has a `workerd` export condition → runs in the worker). `src/emails/layout.tsx`: shared `EmailLayout` chrome (monochrome, inline-styled, email-safe).                                                            |
| Deps       | `+@react-email/components@^1.0.12` (re-exports `@react-email/render@2.0.6`, so no separate `render` dep).                                                                                                                                                                                                                       |
| Tests      | `src/__tests__/email.test.ts` (12 cases: deliver/configured/send paths), `src/__tests__/render-email.test.tsx` (render pipeline → html + text).                                                                                                                                                                                 |
| Test infra | `vite.config.ts`: aliased `cloudflare:workers` → `src/__tests__/helpers/cloudflare-workers-stub.ts` under test (workerd built-in is unresolvable in plain Node — mirrors the `void/db` stub).                                                                                                                                   |

## Key decisions / non-obvious bits

- **Binding access via `cloudflare:workers`, not `c.env`.** The intended call
  sites — Better Auth `sendVerificationEmail`/`sendResetPassword` hooks and the
  monitor queue consumer — don't get a Hono context, so `email.ts` reads
  `import { env } from "cloudflare:workers"` (works in any Void-pages worker
  context). The structured `send()` overload isn't in
  `@cloudflare/workers-types@4.20260522.1` (it only types the legacy
  `send(EmailMessage)`), so we declare a minimal `EmailBinding` interface and
  launder the loosely-typed env at one boundary in `resolveEmailBinding` — the
  same pattern `src/lib/rate-limit.ts` uses for the rate-limiter bindings.
- **Email is optional and graceful by default.** `EMAIL_FROM` is the operator
  opt-in switch (`optional()`, so `void deploy` never hard-fails on it). When
  email isn't set up, `sendEmail` returns `{ sent: false, reason:
"not_configured" }` — it does NOT throw — so a self-hoster who hasn't enabled
  CES is never blocked and call sites don't have to guard. A _transport_
  failure when email IS configured (e.g. domain not onboarded) is a real
  misconfiguration: `deliverEmail` logs via `logger.error` (→ Cloudflare Tail)
  and throws; best-effort callers (alerts) `try/catch`.
- **No new plan barrier.** Wrightful already requires Workers Paid (Queues +
  Cloudflare Containers + Durable Objects), which is exactly CES's requirement,
  so declaring the `send_email` binding doesn't gate deploy on a plan an
  operator wouldn't already have. Onboarding a CES domain + setting `EMAIL_FROM`
  is runtime/config, not deploy-blocking.
- **React Email is NOT the `ui/` library.** Email needs inline-styled,
  table-based HTML (no flex/grid/media-queries), so `EmailLayout` is authored
  separately from `src/components/ui`.

## Verification

- `pnpm --filter @wrightful/dashboard test` — **880 passed** (83 files), incl.
  the 13 new email/render tests (covering graceful-skip, success, and
  transport-failure paths).
- `pnpm --filter @wrightful/dashboard check` — **0 errors** (43 pre-existing
  warnings unrelated to this change).
- `pnpm --filter @wrightful/dashboard typecheck` (`void prepare && tsgo
--noEmit`) — clean (the `cloudflare:workers` import + `EmailBinding` types
  resolve).
- `pnpm --filter @wrightful/dashboard build` — succeeds; generated
  `dist/ssr/wrangler.json` contains `"send_email":[{"name":"EMAIL"}]`.
- React Email `render` proven in the worker-capable build via the render test;
  `@react-email/components` ships a `workerd` export condition.

**Not yet exercised end-to-end:** no route/hook imports `email.ts` yet, so the
`cloudflare:workers` import and React Email aren't in the worker bundle's module
graph. Both get exercised when the first call site lands (Phase 1). On first
`void deploy`, confirm the `EMAIL` binding appears in the deployed worker (same
as `ratelimits` do) and that the sending domain is onboarded to CES.

## Follow-ups (not in this change)

- **Phase 1 — auth emails:** wire `sendVerificationEmail` + `sendResetPassword`
  in `auth.ts`, add verify/forgot/reset pages, flip `requireEmailVerification`.
  (This auto-restores verified-email invite matching in `auth-users.ts`.)
- **Phase 2 — monitor alerts:** alert-config + recipients model, transition
  detection (alert on healthy→down only), cooldown/dedup, templates, wired into
  `recordExecutionResult`/`runMonitorJob`.
