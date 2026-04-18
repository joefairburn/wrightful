# 2026-04-17 — `setup:local` seeds demo user + example Playwright runs

## What changed

`pnpm setup:local` now leaves a fresh local install with a demo account and
three example runs (with real traces, videos, screenshots in R2) so the
dashboard is usable the moment the dev server boots.

The flow:

1. Generate `.dev.vars` (unchanged).
2. Apply D1 migrations (unchanged).
3. **New:** `scripts/seed-demo.mjs` — bootstraps `user`, `account`
   (Better Auth credential via `hashPassword` from `better-auth/crypto`),
   `teams`, `memberships`, `projects`, `api_keys`. Writes resolved url + key
   to `packages/dashboard/.dev.vars.seed.json` (gitignored). Idempotent:
   skips if the demo user already exists.
4. **New:** setup-local polls the dashboard; if it's not already running it
   spawns `pnpm dev` in the background, waits up to 90s for readiness, then
   runs `scripts/upload-fixtures.mjs` and kills the dev server on completion.
   Skippable with `--no-fixtures`.

## Fixture generator

Lives in `packages/dashboard/fixtures/playwright/` (NOT `packages/e2e/` — that
suite must stay green; induced failures would pollute the signal).

- `playwright.config.ts` — `retries: 2`, `trace: "retain-on-failure"`,
  `video: "retain-on-failure"`, `screenshot: "only-on-failure"`. JSON report
  path is controlled by `WRIGHTFUL_FIXTURE_REPORT` env var so each scenario
  gets its own output.
- `tests/cart.spec.ts`, `tests/checkout.spec.ts` — stable passing tests +
  one `test.skip()`. Self-contained via `page.setContent()`, no network.
- `tests/flaky.spec.ts` — gated by `WRIGHTFUL_FIXTURE_FAILURES=1`. Includes a
  deliberate failure (exercises error UI) and a flaky test (`testInfo.retry`
  check — fails first attempt, passes on retry).

## Upload orchestrator

`packages/dashboard/scripts/upload-fixtures.mjs` runs the Playwright suite
three times with different `GITHUB_*` env vars (spoofing CI detection) to
stamp distinct branch / commit / build id metadata on each run. Then invokes
the built `wrightful` CLI binary (`packages/cli/dist/index.js`) against the
running dashboard via `WRIGHTFUL_URL` + `WRIGHTFUL_API_KEY`. Real ingest +
artifact register + R2 PUT — the full production code path.

Scenarios:

| Label              | Branch                | Failures | Expected outcome             |
| ------------------ | --------------------- | -------- | ---------------------------- |
| 01-main-green      | `main`                | no       | all green                    |
| 02-feature-flaky   | `feat/discount-codes` | yes      | fail + flaky + skip + 5 pass |
| 03-main-historical | `main`                | no       | all green                    |

## Demo credentials

- Email: `demo@wrightful.local`
- Password: `demo1234`
- Team: `demo`, project: `playwright`

## Files added

- `packages/dashboard/fixtures/README.md`
- `packages/dashboard/fixtures/playwright/playwright.config.ts`
- `packages/dashboard/fixtures/playwright/tests/{cart,checkout,flaky}.spec.ts`
- `packages/dashboard/scripts/seed-demo.mjs`
- `packages/dashboard/scripts/upload-fixtures.mjs`

## Files modified

- `packages/dashboard/scripts/setup-local.mjs` — added seed + fixture steps.
- `packages/dashboard/package.json` — new scripts (`db:seed-demo`,
  `fixtures:generate`), `@playwright/test` devDep.
- `packages/dashboard/vite.config.mts` — pin port 5173 with `strictPort` so
  vite fails fast instead of silently falling back to 5174 (which would
  break Better Auth callbacks and the fixture upload probe).
- `packages/cli/src/lib/parser.ts` — normalise Playwright's `workerIndex: -1`
  (assigned to tests skipped before dispatch) to `0`; the ingest schema
  requires `>= 0`, and forwarding `-1` caused `pnpm setup:local` uploads to
  400 on any report containing pre-dispatch skips.
- `package.json` (root) — `fixtures:generate` passthrough.
- `.gitignore` — `.dev.vars.seed.json`.

## Verification

- [x] `pnpm --filter @wrightful/cli build` — CLI bundles clean.
- [x] `pnpm typecheck` — both packages pass.
- [x] Standalone Playwright run, failures off: 5 passed, 3 skipped.
- [x] Standalone Playwright run, failures on: 5 passed, 1 failed, 1 flaky, 1
      skipped; traces, videos, screenshots retained.
- [x] `pnpm setup:local` — generates `.dev.vars`, applies migrations, seeds
      demo user, writes `.dev.vars.seed.json`.
- [x] Full orchestrated fixture upload (auto-spawned dev server → real
      ingest + R2 artifact PUT) — verified end-to-end. All three scenarios
      uploaded; failures scenario produced 5 passed / 1 failed / 1 flaky / 1
      skipped with traces, videos, screenshots captured. Re-runs hit the
      idempotency dedup path (`Upload skipped (duplicate — already
    uploaded)`) and return the existing run URL, as designed.

## Known caveats

- `seed-demo.mjs` writes the API key in cleartext to `.dev.vars.seed.json`.
  Local-dev-only; the file is gitignored. Dashboard-side only stores the
  SHA-256 hash.
- If the demo user row exists but `.dev.vars.seed.json` is absent, re-seeding
  the key requires wiping D1 (`rm -rf packages/dashboard/.wrangler`) and
  re-running setup. This mirrors the behaviour of `db:seed-api-key.mjs` —
  the plaintext key is not recoverable once lost.
- Port 5173 is hardcoded in `wrangler.jsonc`'s `WRIGHTFUL_PUBLIC_URL` for
  Better Auth callbacks. If you need a different port, update that var and
  `DASHBOARD_URL` in `seed-demo.mjs` together.
