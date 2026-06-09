# 2026-06-06 — `seed:stream`: watch a run stream into the local dashboard live

## What changed

Added a `pnpm seed:stream` command that drives **one** run of the existing seed
Playwright suite **slowly** through the real `@wrightful/reporter` into a
running local dashboard, so you can watch the run fill in live (rows, artifacts,
outcome tiles) on the run page. It's a manual testing / streaming-demo tool — a
paced sibling of `fixtures:generate` (bulk seeding).

### Why this and not a new suite

The repo already had everything for "run real Playwright tests into the local
dashboard": the customer-shaped seed suite at
`apps/dashboard/scripts/seed/playwright/` (cart / checkout / flaky /
visual-regression) and `scripts/upload-fixtures.mjs` (`pnpm fixtures:generate`),
which streams it through the reporter into `:5173`. The only gap for _watching
streaming_ was pacing: the specs are `page.setContent` + assertions, so a run
finishes in well under a second — too fast to watch. So this change is additive:
optional per-test pacing + a thin single-run orchestrator. It deliberately does
**not** touch the regression suite (`packages/e2e/tests-dashboard/`), which is a
separate concern (it tests Wrightful; this seeds Wrightful).

## Details

| File                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/dashboard/scripts/seed/playwright/pace.ts`                    | **New.** Exports `pace()` — awaits `SEED_DELAY_MS` (default `0` → no-op).                                                                                                                                                                                                                                                                                                                                                                        |
| `…/seed/playwright/{cart,checkout,flaky,visual-regression}.spec.ts` | Import `pace` + register `test.afterEach(pace)`. Registered per file on purpose — a shared `afterEach` in `pace.ts` would only attach to the first spec that imports the (Node-cached) module.                                                                                                                                                                                                                                                   |
| `apps/dashboard/scripts/seed-stream.mjs`                            | **New.** Resolves creds (`WRIGHTFUL_URL`/`WRIGHTFUL_TOKEN` env, else `.env.seed.json`), ensures the dashboard is reachable (`ensureDashboardRunning`), builds the reporter only if `dist` is missing, then runs the suite once with `SEED_DELAY_MS` (default 1500), `WRIGHTFUL_FIXTURE_FAILURES=1`, `--workers=1`, and `stdio: "inherit"`. Prints the runs-list URL up front and a unique CI build id per run so each invocation is a fresh run. |
| `apps/dashboard/package.json`                                       | `"seed:stream": "node scripts/seed-stream.mjs"`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `package.json` (root)                                               | `"seed:stream": "pnpm --filter @wrightful/dashboard seed:stream"`.                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/dashboard/scripts/upload-fixtures.mjs`                        | Pins `SEED_DELAY_MS: "0"` in the bulk seeder's child env so an ambient export can't silently pace `fixtures:generate` / `setup:local`.                                                                                                                                                                                                                                                                                                           |

### Design choices

- **`--workers=1`** so test completions (and therefore streamed rows) arrive one
  at a time instead of bunching across parallel workers.
- **`WRIGHTFUL_FIXTURE_FAILURES=1`** so the run exercises every outcome
  (pass / fail / flaky / skip) plus the artifact + visual-diff pipelines (the
  failures scenario renders V2 against the committed `landing.png` baseline).
- **Build only when `dist` is missing** (vs `upload-fixtures.mjs`, which always
  builds) so repeated `seed:stream` runs stay snappy.
- **No reset, no boot of a second instance** — it streams into the dashboard you
  already have running (`pnpm dev`), so it's additive and safe; the common path
  spawns nothing and tears down nothing.

## Verification

- Static reasoning + an adversarial review pass over the diff (this is a fresh
  workspace with no `node_modules`, so lint/typecheck/playwright could not be run
  here).
- **Manual (requires the user's environment):**
  1. `pnpm install`
  2. `pnpm setup:local` (writes `.env.seed.json`, seeds the demo team/project/key)
  3. `pnpm dev` (dashboard on `:5173`)
  4. `pnpm seed:stream` — open the printed runs-list URL, sign in as
     `demo@wrightful.local` / `demo1234`, click into the new run, and watch rows
     arrive ~every 1.5s with mixed outcomes + real trace/screenshot/video
     artifacts and a visual diff.
  5. Confirm `pnpm fixtures:generate` is unchanged — it pins `SEED_DELAY_MS=0`
     in its child env, so `pace()` is a no-op and bulk seeding stays fast even
     if `SEED_DELAY_MS` is exported in the shell.
- Tune cadence with `SEED_DELAY_MS=3000 pnpm seed:stream`.
