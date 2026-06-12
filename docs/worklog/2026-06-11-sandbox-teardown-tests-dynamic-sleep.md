# 2026-06-11 — Sandbox container teardown: unit-test the `destroy()` contract + plan-resolved idle timeout

## What changed

A review of the synthetic-monitoring sandbox lifecycle (the Cloudflare Container
that runs each browser check) surfaced two cost-leak gaps. Both are now closed:

1. **The cost-critical `destroy()` call had zero automated coverage.** It lived
   in `SandboxExecutor.execute()` — an integration-only class the vitest harness
   can't import (it pulls in `void/sandbox` / `void/env`) — wrapped in a
   swallowed `.catch(() => {})`. A refactor that dropped, reordered, or
   early-returned past it would have passed all of CI silently.

2. **A leaked container idled for the SDK-default `sleepAfter` of 10 minutes.**
   `getSandbox(execution.id)` passed no options, so when teardown never runs
   (queue Worker evicted / CPU-killed mid-run, or `destroy()` itself fails) the
   container billed ~10 idle minutes after a ~45s check before auto-sleeping.

The fix mirrors the existing `executor.ts` (pure) / `queues/monitors.ts`
(adapter) split: the container lifecycle is extracted into a pure,
dependency-injected function so the teardown is exercised by unit tests, and the
idle timeout is now resolved per plan and defaulted tight.

## Details

| File                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/monitors/sandbox-run.ts`                   | **New.** Pure `runSandboxExecution(input, deps)` — the whole acquire → scaffold → exec → resolve → **`finally` teardown** lifecycle, with every effect (`getSandbox`, mint/revoke key, scope, find-run, clock) injected via `SandboxRunDeps`. No `void/sandbox` / `void/env` imports, so it is harness-importable. `SandboxLimitError` is classified via an injected `classifyLimitError` predicate (keeps `instanceof` in the adapter). A structural `SandboxHandle` interface avoids importing `@cloudflare/sandbox` types. |
| `src/lib/monitors/sandbox-executor.ts`              | **Rewritten as a thin adapter.** `SandboxExecutor` now only wires the real `void/sandbox` + `void/db` IO, env-derived `maxDurationMs` / `publicUrl`, the plan-resolved `sleepAfter`, and `Date.now` into `runSandboxExecution`. ~180 lines of logic moved out; the class is ~30 lines of wiring. Behaviour is byte-for-byte preserved (same env, same error policy, same messages).                                                                                                                                           |
| `src/lib/monitors/sandbox-policy.ts`                | **New.** Pure per-plan container policy. `sandboxSleepAfter(plan)` (backed by a `Record<MonitorPlan, string>` so adding a plan is a compile error until its idle timeout is set) + `resolveMonitorPlan(monitor)`. `MonitorPlan` is `"default"` only today (no billing model exists) → every tenant gets **`60s`** (down from the SDK's `10m`).                                                                                                                                                                                |
| `src/lib/monitors/__tests__/sandbox-run.test.ts`    | **New, 13 tests.** Pins the teardown invariant: `destroy()` is called on pass, app-fail, wall-clock timeout, and mid-run throw; is **not** called when no container started (getSandbox throws, empty source, scope/mint failure); a failing `destroy()` never flips the recorded result; the key is always revoked; and the plan-resolved `sleepAfter` reaches `getSandbox`.                                                                                                                                                 |
| `src/lib/monitors/__tests__/sandbox-policy.test.ts` | **New, 2 tests.** Pins the default-plan idle timeout (`60s`) and that every monitor resolves to the default plan.                                                                                                                                                                                                                                                                                                                                                                                                             |

## Why `sleepAfter` is the right cost knob (and why `60s` is safe)

`sleepAfter` **only bounds a leaked container's idle billing** — a healthy run is
torn down immediately in the `finally`, so it never reaches the idle timer. It
matters only when teardown never runs. Shorter is therefore strictly
cheaper-on-leak with **no** downside to a healthy run: the Sandbox SDK busy-polls
once per second (`BUSY_POLL_INTERVAL_MS = 1000`) and renews the container's
activity deadline while an `exec` is in flight, so a live check (up to the 300s
budget) stays alive regardless of this value — the idle countdown only starts at
the busy→idle edge. `60s` keeps a wide margin over the 1s poll while cutting the
worst-case leak from ~10 min to ~1 min (~10×).

The mechanism is per-plan because that is the natural seam if premium tenants
should later get different container behaviour; with no `teams.plan` column yet,
`resolveMonitorPlan` returns `"default"` for everyone and the per-plan branch is
a one-function edit when billing lands. (Note for later: the higher-impact
per-plan knobs are really check _interval_ and _max-duration_, not idle.)

## Not changed (deliberately)

- The stale-execution reaper (`sweepStaleExecutions`) still only flips the DB row
  to `error`; it does not force-`destroy()` the container. With `sleepAfter` now
  `60s`, a leaked container self-sleeps long before the 30-min reaper would run,
  so a reaper-driven destroy is redundant. Left as-is.

## Verification

- `pnpm --filter @wrightful/dashboard exec vp test run src/lib/monitors` — **44 passed** (15 new).
- `pnpm check` (oxfmt + oxlint + type-aware typecheck) — **0 errors**, 0 new warnings (the 70 warnings are pre-existing in `packages/reporter/src/client.ts`).
- Adapter wiring (`getSandbox` stub → structural `SandboxHandle`, `classifyLimitError`) type-checks against the real `void/sandbox` signature.
