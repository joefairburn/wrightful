# Fixtures

Locally-generated example data that makes a fresh `pnpm setup:local` install
look alive. Everything here is for local development only — nothing ships to
production.

## What gets generated

`packages/dashboard/scripts/upload-fixtures.mjs` runs the Playwright suite in
`fixtures/playwright/` two or three times with different CI env vars (branch,
commit, build id), then calls `wrightful upload` against the running local
dashboard. Each invocation goes through the real ingest + artifact flow, so
the seeded runs include actual traces, videos, and screenshots in R2.

## Prerequisites

1. `pnpm setup:local` — runs migrations and bootstraps the demo user/team/
   project/API key (written to `.dev.vars.seed.json`, gitignored).
2. `pnpm dev` — dashboard must be running on `http://localhost:5173`.

Then:

```
pnpm fixtures:generate
```

## Demo credentials

After `setup:local`:

- Email: `demo@wrightful.local`
- Password: `demo1234`
- Team slug: `demo`, project slug: `playwright`

## Scenarios

| File               | Branch                | Outcome             |
| ------------------ | --------------------- | ------------------- |
| 01 main-green      | `main`                | all green           |
| 02 feature-flaky   | `feat/discount-codes` | fail + flaky + skip |
| 03 main-historical | `main` (3 days ago)   | all green           |

The flaky/failing cases are gated behind `WRIGHTFUL_FIXTURE_CHAOS=1` so the
suite stays silent unless the generator opts in.

## Why Playwright-in-dashboard, not Playwright-in-e2e

`packages/e2e/` houses our real Playwright E2E suite. Those tests must stay
green. The fixture generator lives here so induced failures don't leak into
that signal.
