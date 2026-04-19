# Wrightful

A Playwright test reporting dashboard. Ships as two pieces:

- **`@wrightful/reporter`** — Playwright reporter that streams results and artifacts to the dashboard live as each test completes.
- **`@wrightful/dashboard`** — a Cloudflare Worker (Vite + React 19 RSC on RedwoodSDK, Drizzle ORM on D1, R2 for artifacts) that ingests results and serves the UI.

## Deploy your own dashboard

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joefairburn/wrightful/tree/main/packages/dashboard)

One click provisions a D1 database, an R2 bucket, and the Worker bindings from `packages/dashboard/wrangler.jsonc`, then runs `deploy` — which applies D1 migrations before publishing the worker, so the schema is ready on first load. Artifact uploads and downloads use the native R2 binding, so no S3 credentials are needed. A few manual steps remain:

1. **Sign up** in the deployed dashboard and **create a team + project** via `/admin/teams/new` and `/admin/t/<team-slug>/projects/new`.
2. **Seed an initial API key**, scoped to that project.

   ```bash
   pnpm --filter @wrightful/dashboard db:seed-api-key "my-laptop" --team <team-slug> --project <project-slug>
   ```

   Save the printed key — the server only stores its SHA-256 hash.

## Wire up the reporter

In your Playwright project:

```bash
pnpm add -D @wrightful/reporter
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [["list"], ["@wrightful/reporter"]],
});
```

Set credentials in CI:

```yaml
env:
  WRIGHTFUL_URL: https://wrightful.<your-subdomain>.workers.dev
  WRIGHTFUL_TOKEN: ${{ secrets.WRIGHTFUL_TOKEN }}
```

Results appear in the dashboard live as tests complete. Shards converge on a single run via a deterministic idempotency key derived from `GITHUB_RUN_ID` (or the equivalent on GitLab/CircleCI). See [`examples/github-actions-workflow.yml`](./examples/github-actions-workflow.yml) for a full workflow.

## Local development

```bash
pnpm install
pnpm setup:local                                # .dev.vars + D1 migrations + demo data
pnpm dev                                        # dashboard on localhost

# Seed an additional API key for local testing (optional):
pnpm --filter @wrightful/dashboard db:seed-api-key e2e --team <team-slug> --project <project-slug> --local
```

See [`CLAUDE.md`](./CLAUDE.md) for the full command reference (tests, lint, typecheck, migrations) and [`docs/worklog/`](./docs/worklog/) for decision history.
