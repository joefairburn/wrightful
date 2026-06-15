# 2026-06-13 — Email verification/reset + monitor down/recovery alerts

Builds on the same-day CES email foundation
(`2026-06-13-email-foundation-ces.md`). That landed the transport
(`sendEmail`), React-Email rendering, and the optional/graceful contract; this
wires it to the two real use cases. Everything stays graceful when email is off
(no `EMAIL_FROM`): verification doesn't turn on, and alert sends are no-ops.

## Phase 1 — Auth email verification + password reset

**What changed**

- **`auth.ts`**: added Better Auth hooks `emailVerification.sendVerificationEmail`
  - `emailAndPassword.sendResetPassword`, and `emailVerification.sendOnSignUp` /
    `autoSignInAfterVerification`. `requireEmailVerification` and `sendOnSignUp`
    are gated on `Boolean(process.env.EMAIL_FROM)` (`emailConfigured`) — read from
    `process.env` (not `void/env`) because `auth.ts` is also evaluated at `void
prepare`, same as the existing GitHub/open-signup gating. **No sender ⇒ no
    verification requirement** (preserves prior behavior).
- **`src/lib/auth-email.tsx`**: renders + sends the verification/reset emails.
  The `auth.ts` hooks reach it via a request-time dynamic `import()` (the
  GitHub-mirror pattern), since it pulls the React-Email renderer + the
  `cloudflare:workers` binding, neither of which resolves at config time. Both
  helpers `await sendEmail`, so a transport failure surfaces in the hook (signup
  fails loudly rather than stranding an unverifiable account).
- **Templates**: `src/emails/verify-email.tsx`, `src/emails/reset-password.tsx`
  (+ shared element styles exported from `src/emails/layout.tsx`).
- **Pages**: new `forgot-password` + `reset-password` (token read server-side
  from the Better-Auth redirect's `?token=`/`?error=`); `signup.tsx` shows a
  "check your inbox" state when verification is on (`signUp.email` returns no
  session); `login.tsx` gains a "Forgot password?" link. Reset entry points
  (`/forgot-password`, the login link) are hidden/redirected when `EMAIL_FROM`
  is unset.
- Wiring verification flips `emailVerified` for password accounts, which
  auto-restores their email-based directed-invite matching in `auth-users.ts`.

**Notes**: the client method is `auth.requestPasswordReset` (not the older
`forgetPassword`, which 1.6.x dropped from the client type). `ALLOW_OPEN_SIGNUP`
default stays `false` (open signup is a separate decision from verification).

## Phase 2 — Monitor down/recovery alerts

**What changed**

- **Schema**: `monitors.alertsEnabled` (integer bool, default 1). Migration
  `db/migrations/20260613161750_empty_richard_fisk.sql` — additive
  `ALTER TABLE … ADD COLUMN`. `MONITOR_COLUMNS` + `createMonitor` updated.
- **`src/lib/monitors/alerts.tsx`**:
  - `classifyAlert(prev, next)` (pure) — edge-triggered: healthy→down ⇒ `"down"`,
    down→healthy ⇒ `"recovery"`, else `null`. Down = `fail|error`; `degraded`
    is treated as healthy.
  - `shouldSendAlert(monitor, prev, next)` (pure) — gates on `alertsEnabled`.
  - `sendMonitorAlert` — recipients = all team members
    (`memberships ⋈ user.email`), deep-links via slug lookup + `WRIGHTFUL_PUBLIC_URL`,
    renders `MonitorAlert` + `sendEmail`.
  - `maybeSendMonitorAlert` — the injected effect; decides then sends,
    swallowing all errors (best-effort, like `broadcast`).
- **Wiring**: `runMonitorJob` captures the monitor's prior `lastStatus` before
  `recordResult` overwrites it, then calls a guarded `safeAlert(...)` after
  recording on both the success and infra-error paths. The new `alert?` dep on
  `RunMonitorJobDeps` is **optional** (existing executor tests omit it); wired to
  `maybeSendMonitorAlert` in `queues/monitors.ts` + `queues/uptime.ts`.
  `claim()` (CAS) already prevents double-fire on at-least-once redelivery, and
  the edge-trigger dedups the retry (prev becomes down, so a still-down redelivery
  is silent).
- **UI**: per-monitor `setMonitorAlertsEnabled` repo fn + `toggleAlerts` action +
  a "Mute/Unmute alerts" button and an "Alerts" meta item on the monitor detail
  page (mirrors the existing pause/resume).

**Policy** (confirmed with the user): recipients = all team members; alert on
`fail`/`error`, recover on return to healthy; `degraded` doesn't alert.

**Known v1 gaps (intentional)**: reaper-killed stuck executions
(`sweepStaleExecutions`) bypass `runMonitorJob` and leave `lastStatus`
untouched, so they don't alert. No per-alert recipient list, no
consecutive-failure threshold / cooldown beyond edge-triggering yet.

## Verification

- `pnpm --filter @wrightful/dashboard test` — **893 passed** (85 files), incl.
  13 new (auth-email render/send ×4, alerts ×9: classify table, alertsEnabled
  gate, template render, and the `runMonitorJob` alert-wiring + error-swallow).
- `pnpm --filter @wrightful/dashboard check` — **0 errors** (43 pre-existing
  warnings).
- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm --filter @wrightful/dashboard build` — succeeds; the worker bundle now
  pulls the alert path (queues → `alerts.tsx` → React Email + the email
  binding), so the end-to-end worker bundling of React Email + `cloudflare:workers`
  is exercised (it wasn't in Phase 0, which had no call site).

**On first deploy with email**: onboard the `EMAIL_FROM` domain to CES, then
verify (a) a signup sends a verification email and gates login, (b) taking a
monitor down emails the team once (not every interval) and recovery emails on
return.
