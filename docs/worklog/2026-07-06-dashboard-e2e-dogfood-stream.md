# 2026-07-06 — Dashboard e2e suite dogfoods into prod Wrightful on push to main

## What changed

The **dashboard e2e suite** (`packages/e2e/tests-dashboard/`, `playwright.dashboard.config.ts`)
now streams its results into a Wrightful dashboard via `@wrightful/reporter`,
and **every push to `main` streams the real suite to prod** (`dash.wrightful.dev`).

Previously the *only* suite wired with the reporter was the **demo suite**
(`tests/demo.spec.ts` — drives playwright.dev), streamed by the label-gated
`dogfood-stream` CI job. The prod dashboard therefore filled with synthetic
playwright.dev demo tests rather than the project's own meaningful coverage
(auth, navigation, realtime, cross-tenant isolation, monitors, run/test detail).

Now the dashboard suite — the one that actually exercises Wrightful — is what
dogfoods on merge.

## Details

| File | Change |
| --- | --- |
| `packages/e2e/playwright.dashboard.config.ts` | Added `["@wrightful/reporter"]` to **both** reporter arrays (the minimal `line`/`html` CI/agent branch and the interactive `list` branch), mirroring `playwright.config.ts`. Introduced a `dashboardReporter` const so both branches stay in sync. |
| `.github/workflows/ci.yml` (`test-e2e-ui` job) | Added `WRIGHTFUL_URL` + `WRIGHTFUL_TOKEN` (from `secrets.WRIGHTFUL_URL` / `secrets.WRIGHTFUL_TOKEN`) to the "Run dashboard UI e2e tests" step env. Streams on **both PRs and push-to-main**; only fork PRs (secrets withheld) resolve to `''` and no-op. Uses the real/main project token. |
| `.github/workflows/ci.yml` (`dogfood-stream` job) | Repointed the demo suite from `secrets.WRIGHTFUL_TOKEN` to `secrets.WRIGHTFUL_DOGFOOD_TOKEN` so synthetic demo runs land in a dedicated dogfood project, kept separate from the real suite's project. |
| `.github/workflows/ci.yml` (`test-e2e-ui` job) | Added a **Build reporter** step. Playwright resolves every reporter at config-load time, so once `playwright.dashboard.config.ts` references `@wrightful/reporter`, its `dist/` must exist even on the env-less PR leg — otherwise the config fails to load with `MODULE_NOT_FOUND` before any test runs. |

### Why it's safe to always configure the reporter

`@wrightful/reporter` checks `WRIGHTFUL_URL`/`WRIGHTFUL_TOKEN` at `onBegin`
(`packages/reporter/src/index.ts:271-274`) and cleanly early-returns with
`"streaming disabled"` when either is missing. So:

- **Local runs** stay quiet (no creds in env) — verified via `playwright test --list`.
- **PR CI runs** stay quiet — the env expression yields `''` on `pull_request` events.
- **Push-to-main CI** streams — `github.event_name == 'push'` injects the URL + `secrets.WRIGHTFUL_TOKEN`.

### Stream target vs. test target

The dashboard suite boots its **own local dashboard at `:5189`** (its Playwright
`baseURL` — what it tests against). `WRIGHTFUL_URL` is a *separate* concern: the
dashboard the reporter *streams to*. They are intentionally different.

### Suite ↔ project isolation

The real dashboard suite (`test-e2e-ui`) streams to the main project
(`WRIGHTFUL_TOKEN`) on every PR and push. The synthetic demo suite
(`dogfood-stream`) streams to a dedicated dogfood project
(`WRIGHTFUL_DOGFOOD_TOKEN`) only on labeled PRs. On a labeled PR both can stream
at once, but they write to **separate projects**, so real and synthetic data
never mix. `dogfood-stream` was left in place; it can be retired separately if
the demo-suite dogfood is no longer wanted.

## To stream locally

```bash
DATABASE_URL="postgresql://wrightful:wrightful@localhost:5432/wrightful_e2e" \
WRIGHTFUL_URL="https://dash.wrightful.dev" \
WRIGHTFUL_TOKEN="<a project API key on that dashboard>" \
pnpm --filter @wrightful/e2e test:dashboard
```

## Verification

- `playwright test --config=playwright.dashboard.config.ts --list` — reporter
  loads and self-disables: `[wrightful] WRIGHTFUL_URL or WRIGHTFUL_TOKEN not set — streaming disabled.`
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — YAML parses.
- Local full run (`test:dashboard` against `wrightful_e2e`, no creds) — 43 passed,
  1 skipped, 3 known timing-flaky specs (absorbed by `retries: 2` in CI).
