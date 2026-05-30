# 2026-05-30 — Shared dashboard-readiness probe seam (F64)

## What changed

`apps/dashboard/scripts/upload-fixtures.mjs` carried a verbatim copy of the
dashboard-readiness probe (`POST /api/runs` with an empty body + Bearer key,
`X-Wrightful-Version: 3`, treating `400` = ready / `401` = auth-rejected /
anything-else = not-ready) and a bespoke re-implementation of the
spawn + 90s-poll + SIGINT/SIGTERM orchestration that `scripts/lib/dev-server.mjs`
already exposes as `ensureDashboardRunning`. `setup-local.mjs` was the clean
counterexample — it imports `startDevServerForSeed` and never inlines a probe.

This collapses the duplicate into the existing `lib/dev-server.mjs` deep module:

- Extracted the readiness convention into a pure, side-effect-free module
  `scripts/lib/probe-status.mjs` exporting `classifyProbe(status) →
"ready" | "auth-rejected" | "not-ready"`. This is now the single source of
  truth for what the empty-body `POST /api/runs` probe means.
- `lib/dev-server.mjs` imports `classifyProbe` and routes both its one-shot
  check and its poll loop through it (replacing inline `=== 400` / `=== 401`
  literals). The poll loop now also honours `auth-rejected` mid-poll, matching
  the behaviour upload-fixtures had.
- Generalized `ensureDashboardRunning(seed, opts)` to accept an injected
  `opts.onAuthRejected(baseUrl)` callback. The default keeps the existing
  `.env.seed.json` remediation; `upload-fixtures.mjs` injects its env-mode
  variant ("Re-check WRIGHTFUL_URL + WRIGHTFUL_TOKEN") for the e2e-suite caller.
- `upload-fixtures.mjs` now imports `ensureDashboardRunning` and deletes its
  local `probe()` / `authRejected()` / `devServer` / `ensureDashboardRunning()`
  block. It picks up the lib helper's free-port fallback + spinner + exit
  detection for free, and threads the returned `baseUrl` through (the existing
  `baseUrl !== seed.url` summary branch now meaningfully fires when a fallback
  port was used, mirroring `setup-local`'s `startDevServerForSeed` usage).

## Details

| File                                                    | Change                                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/scripts/lib/probe-status.mjs`           | New side-effect-free module: `classifyProbe`.                                                                                                |
| `apps/dashboard/scripts/lib/probe-status.d.mts`         | Hand-written declaration (the `scripts/` tree is `.mjs` glue outside the `src` program) so the `src/__tests__` test imports with real types. |
| `apps/dashboard/scripts/lib/dev-server.mjs`             | Import + use `classifyProbe`; `ensureDashboardRunning` takes injectable `onAuthRejected`; poll loop handles `auth-rejected`.                 |
| `apps/dashboard/scripts/upload-fixtures.mjs`            | Delete verbatim probe + bespoke orchestration; call shared `ensureDashboardRunning` with injected env-mode 401 message.                      |
| `apps/dashboard/src/__tests__/dev-server-probe.test.ts` | New unit tests for `classifyProbe`.                                                                                                          |

## Why `classifyProbe` lives in its own module

`lib/dev-server.mjs` does a module-level `fileURLToPath(new URL(...))` to locate
the repo root for spawning `vp dev`. That throws under vitest's module runner
("The URL must be of scheme file"), so the file can't be imported by a unit
test. Isolating the pure classifier into `probe-status.mjs` (no top-level
side effects) gives a clean unit-test surface — the same pattern F61/F63 used
for `seed/ingest-runs.mjs`.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (0 errors).
- `pnpm --filter @wrightful/dashboard exec` vitest on `dev-server-probe.test.ts`
  — 4 passed.
- Full dashboard suite (`vp test run`) — 52 files / 589 tests passed.
- `vp lint` on the four touched files — 0 warnings, 0 errors.

Deletion test: removing upload-fixtures' inline probe does not vanish
complexity — the readiness convention + spawn/poll/signal orchestration still
has to exist, and now does in exactly one place (`lib/dev-server.mjs` +
`lib/probe-status.mjs`) consumed by both real callers (`setup-local` via
`startDevServerForSeed`, `upload-fixtures` via `ensureDashboardRunning`).
