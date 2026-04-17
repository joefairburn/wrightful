# Wrightful

A Playwright test reporting dashboard. Ships as three pieces:

- **`@wrightful/cli`** — parses Playwright JSON reports and uploads runs/artifacts to a dashboard.
- **`@wrightful/dashboard`** — a Cloudflare Worker (Vite + React 19 RSC on RedwoodSDK, Drizzle ORM on D1, R2 for artifacts) that ingests reports and serves the UI.
- **`@wrightful/github-action`** — GitHub Action wrapping the CLI for CI use.

## Deploy your own dashboard

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joefairburn/wrightful/tree/main/packages/dashboard)

One click provisions a D1 database, an R2 bucket, and the Worker bindings from `packages/dashboard/wrangler.jsonc`, then runs `deploy` — which applies D1 migrations before publishing the worker, so the schema is ready on first load. Three manual steps remain:

1. **Create R2 S3-compatible credentials.** R2 presigning needs an access key pair — Cloudflare cannot auto-create these.
   Cloudflare dashboard → R2 → Manage API Tokens → Create API Token (scoped to the provisioned bucket, Object Read & Write). Then:

   ```bash
   cd packages/dashboard
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   ```

2. **Set `R2_ACCOUNT_ID`.** Either edit `wrangler.jsonc` (`vars.R2_ACCOUNT_ID`) and redeploy, or set it in the Cloudflare dashboard under Worker → Settings → Variables.

3. **Seed an initial API key for the CLI.**

   ```bash
   pnpm --filter @wrightful/dashboard db:seed-api-key "my-laptop"
   ```

   Save the printed key — the server only stores its SHA-256 hash.

Point the CLI at the new dashboard:

```bash
export WRIGHTFUL_URL=https://wrightful.<your-subdomain>.workers.dev
export WRIGHTFUL_API_KEY=wrf_live...
pnpm --filter @wrightful/cli exec wrightful upload path/to/playwright-report.json
```

## Local development

```bash
pnpm install
pnpm dev                                        # dashboard on localhost
pnpm --filter @wrightful/dashboard db:migrate:local
pnpm --filter @wrightful/dashboard db:seed-api-key e2e --local
```

See [`CLAUDE.md`](./CLAUDE.md) for the full command reference (tests, lint, typecheck, migrations) and [`docs/worklog/`](./docs/worklog/) for decision history.
