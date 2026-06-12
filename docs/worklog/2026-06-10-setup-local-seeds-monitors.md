# 2026-06-10 — `setup:local` seeds example synthetic monitors

## What changed

`pnpm setup:local` now seeds a handful of **synthetic monitors** into the demo
project, so the Monitors page (shipped in `2026-06-07-synthetic-monitoring.md`)
isn't empty out of the box — the same way it already seeds a demo team, project,
API key, and example Playwright runs.

Two parts:

1. **Seed the monitor definitions** (`scripts/seed-demo.mjs`). The seed script
   already holds the demo session cookies + resolved slugs, so it POSTs each
   monitor to the **same `?createMonitor` page action the create form uses** —
   urlencoded form fields (`name`, `type=browser`, `source`, `intervalSeconds`,
   `enabled`), identical to what the browser submits. No new API route. The
   action 302s to the new monitor's detail on success, or back to
   `…/monitors/new?formError=` on failure; the script reads the `Location`
   (`request()` already uses `redirect: "manual"`) and aborts on a `formError`.

2. **Make local execution actually work** (`scripts/setup-local.mjs` →
   `.env.local`). `WRIGHTFUL_MONITOR_EXECUTOR` defaults to `sandbox`, but
   `vp dev` runs with `dev.enable_containers=false` (wrangler.jsonc), so a
   scheduled monitor would _error_ at execution time locally. setup:local now
   writes `WRIGHTFUL_MONITOR_EXECUTOR=stub` into `.env.local` (the documented
   correct local executor — the in-process `StubExecutor`, no Docker), via an
   `ensureMonitorExecutor` helper modeled on the existing `ensureOpenSignup`.
   It only adds the key when absent/commented, so an explicit user value (e.g.
   someone testing the sandbox path) is left untouched.

## The seeded set

Four browser monitors, chosen to exercise the list/detail states:

| Name                       | Interval | Enabled | Note                                            |
| -------------------------- | -------- | ------- | ----------------------------------------------- |
| Homepage — loads & title   | 1m       | yes     | shortest interval → first to become due         |
| Checkout — reach payment   | 5m       | yes     | multi-step spec                                 |
| Pricing — known regression | 10m      | yes     | source carries the `FORCE_FAIL` sentinel        |
| Login smoke (staging)      | 1h       | no      | paused → exercises the paused list/detail state |

The `FORCE_FAIL` sentinel is what the `StubExecutor` keys on to synthesize a
_failing_ run, so the demo shows a red monitor next to the green ones without
depending on a real (flaky) target site.

## Details

| File                          | Change                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/seed-demo.mjs`       | New `DEMO_MONITORS` const + a seeding loop (step 5, before the seed-file write) POSTing each to `?createMonitor`. Summary line.  |
| `scripts/setup-local.mjs`     | `ensureMonitorExecutor()` applied in both `.env.local` branches (create + update); "monitors: seeded" line in the final summary. |
| `apps/dashboard/.env.example` | Documented (commented) `WRIGHTFUL_MONITOR_EXECUTOR=stub` with the rationale.                                                     |
| `README.md`                   | `setup:local` line now mentions example monitors.                                                                                |

No schema, route, or runtime-code changes — this is dev-tooling only, building
on the existing monitor create action + stub executor.

## Behavioral note (expected, not a bug)

The seeded enabled monitors **arm but don't execute during the seed**, and
won't auto-run under plain `pnpm dev` either: Cloudflare's local dev does not
fire crons on a real schedule (the sweep cron `* * * * *` is dormant until
triggered). Until the sweep runs, each monitor shows "No executions yet". To see
them run locally, trigger the sweep via Void's dev endpoint
(`POST /__void/scheduled` with `{ cron: "* * * * *" }` + the dev-trigger token,
as the e2e does) — the 1-minute monitor is due ~60s after creation. On a
deployed dashboard the real cron drives them. Fabricating backdated execution
history during seed was deliberately **not** done — there's no ingest path for
`monitorExecutions` (they're produced by the queue consumer), so it would need
either a 60s+ wait per cycle or new infrastructure.

## Verification

- `node --check` on both modified scripts: **OK**.
- `vp fmt --write` + `vp lint` on the changed scripts: **0 warnings, 0 errors**.
- Form-action seeding path validated against the code: the create form posts the
  identical urlencoded fields to `…/monitors/new?createMonitor`, parsed by the
  action's `c.req.formData()`; `01.context.ts` resolves the tenant from the
  session cookie for `/t/:teamSlug/p/:projectSlug/*` POSTs, and the demo user is
  the team owner, so `requireOwnerTenantContext` passes.
- End-to-end (`pnpm setup:local` against a live dev server) deferred to the user
  per the no-dev-server convention.
