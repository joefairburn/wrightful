# Self-hosting Wrightful

Wrightful's dashboard is a [Void](https://void.cloud) app that runs on Cloudflare Workers: one Worker for the dashboard + ingest API, a single D1 database (auth, tenancy, runs, and test data), and one R2 bucket for artifact bytes. `void deploy` builds the app, applies Drizzle migrations, and provisions the D1/R2/KV bindings for you — there's no manual resource creation and no separate migrate step.

You don't need your own Cloudflare account: `void deploy` ships to Void's managed Cloudflare platform by default. If you'd rather run on your own Cloudflare account, see [Deploying to your own Cloudflare account](#deploying-to-your-own-cloudflare-account) at the end.

There are two supported paths. Pick one:

- **[Path A: CLI deploy](#path-a-cli-deploy-recommended)** — `void deploy` from your machine. Fastest way to get running.
- **[Path B: GitHub Actions](#path-b-github-actions)** — auto-deploy on every push to `main`.

---

## Path A: CLI deploy (recommended)

Prerequisites: Node 20+, `pnpm`, a Void account.

```bash
git clone https://github.com/<your-username>/wrightful.git
cd wrightful
pnpm install

# 1. Authenticate + link a Void project (interactive). Saves .void/project.json.
pnpm --filter @wrightful/dashboard exec void auth login

# 2. Generate the auth secret and set it as a remote secret.
openssl rand -base64 32 | pnpm --filter @wrightful/dashboard exec void secret put BETTER_AUTH_SECRET

# 3. Set the public origin (your deployed URL) as a secret too. You can
#    deploy once to discover the URL, then set this and redeploy.
pnpm --filter @wrightful/dashboard exec void secret put WRIGHTFUL_PUBLIC_URL

# 4. Deploy. Builds, applies db/migrations/, provisions D1 + R2 + KV, goes live.
pnpm deploy
```

`pnpm deploy` runs `void deploy` for the dashboard. On deploy, Void reads the checked-in SQL migrations from `apps/dashboard/db/migrations/`, fails if the schema has drifted ahead of them (run `void db generate`, commit, retry), applies any pending migrations to the D1 database, then makes the new version live. You never edit binding config by hand.

Then jump to [Sign up + wire up the reporter](#sign-up--wire-up-the-reporter).

---

## Path B: GitHub Actions

Auto-deploy on push. Generate the workflow with `void init --github` (writes `.github/workflows/deploy.yml`), or add one that runs `void deploy` with a deploy token:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: voidzero-dev/setup-vp@v1
        with:
          node-version: "22"
          cache: true
      - run: pnpm install
      - run: pnpm --filter @wrightful/dashboard exec void deploy
        env:
          VOID_TOKEN: ${{ secrets.VOID_TOKEN }}
          VOID_PROJECT: <your-project-slug>
```

Get a deploy token with `void auth token` and add it as the `VOID_TOKEN` GitHub Actions secret. Set the app's own secrets (`BETTER_AUTH_SECRET`, `WRIGHTFUL_PUBLIC_URL`, etc.) once with `void secret put` — remote secrets persist across deploys and count as "present" for deploy-time validation.

---

## Environment variables

Every key is declared and validated in `apps/dashboard/env.ts`. For local dev, copy `apps/dashboard/.env.example` to `apps/dashboard/.env.local` and fill it in. For production, set values as remote secrets (`void secret put NAME`) or in shipped `.env.production` — `void deploy` hard-errors before upload if a required key is missing from the union of `.env*` files and remote secrets.

**Required:**

- `WRIGHTFUL_PUBLIC_URL` — the public origin users hit (e.g. `https://wrightful.<you>.workers.dev` or a custom domain). Used by Better Auth for OAuth callbacks and for the artifact-download token audience.
- `BETTER_AUTH_SECRET` — 32+ random bytes (`openssl rand -base64 32`). Signs session cookies and artifact download tokens. On Void's managed platform this is auto-created if unset.

**Optional:**

- `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` — enable "Continue with GitHub". Register an [OAuth app](https://github.com/settings/developers) with callback `${WRIGHTFUL_PUBLIC_URL}/api/auth/callback/github`. Both must be set or the button stays hidden.
- `ALLOW_OPEN_SIGNUP` (`true`/`false`, default `false`) — allow anyone to register. Off by default because email verification isn't wired up yet; leave off for public instances and add users via invites.

| Name                           | Required? | Default | Purpose                                                                  |
| ------------------------------ | --------- | ------- | ------------------------------------------------------------------------ |
| `WRIGHTFUL_PUBLIC_URL`         | Yes       | —       | Public origin. OAuth callbacks + artifact download token audience.       |
| `BETTER_AUTH_SECRET`           | Yes       | —       | Signs session cookies + artifact download tokens. 32+ random bytes.      |
| `AUTH_GITHUB_CLIENT_ID`        | No        | —       | Enables "Continue with GitHub" sign-in.                                  |
| `AUTH_GITHUB_CLIENT_SECRET`    | No        | —       | Pair with `AUTH_GITHUB_CLIENT_ID`.                                       |
| `ALLOW_OPEN_SIGNUP`            | No        | `false` | Allow public sign-up.                                                    |
| `WRIGHTFUL_MAX_ARTIFACT_BYTES` | No        | 50 MiB  | Per-artifact upload size cap.                                            |
| `WRIGHTFUL_RUN_STALE_MINUTES`  | No        | 30      | How long a run can sit `running` before the cron watchdog interrupts it. |

---

## Sign up + wire up the reporter

Open your `WRIGHTFUL_PUBLIC_URL` in a browser.

1. **Sign up** with email/password (or GitHub if configured). Set `ALLOW_OPEN_SIGNUP=true` first if you're the first user, then turn it off.
2. Create a team via `/settings/teams/new`.
3. Create a project via `/settings/teams/<team-slug>/projects/new`.
4. Generate an API key from the project's keys page (`/settings/teams/<team-slug>/p/<project-slug>/keys`). Save the printed key — only its SHA-256 hash is stored server-side.

In your Playwright project's CI, set:

```bash
WRIGHTFUL_URL=https://wrightful.<your-account>.workers.dev
WRIGHTFUL_TOKEN=<the key from step 4>
```

Then install the reporter:

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

Results stream to your dashboard as tests run.

---

## Updating your instance

```bash
git pull origin main
pnpm install
pnpm deploy        # or push to main if you set up Path B
```

`void deploy` applies any new migrations automatically before going live.

---

## Deploying to your own Cloudflare account

`void deploy` targets Void's managed platform by default. To deploy to your own Cloudflare account instead, add a `wrangler.jsonc` to `apps/dashboard/` with real resource IDs for the bindings Void infers (D1, R2, KV) — Void merges it with the inferred binding set. See the Void [Cloudflare integration guide](https://void.cloud) for the current details. (The repo already ships a `wrangler.jsonc` carrying the rate-limiter bindings; extend it rather than replacing it.)

---

## Troubleshooting

**First load 500s on sign-in pages** — `WRIGHTFUL_PUBLIC_URL` or `BETTER_AUTH_SECRET` isn't set. Run `void env check --remote` to see which required key is missing; check Worker logs via `void project logs --level error`.

**`void deploy` fails with schema drift** — your `db/schema.ts` is ahead of the committed migrations. Run `void db generate`, review the new file in `apps/dashboard/db/migrations/`, commit it, then redeploy. Deploy always uses checked-in migration files.

**Migration discipline** — schema changes are forward-only / additive (new tables, new nullable columns). Generate a new numbered migration with `void db generate`; never edit a migration that has already been applied to a live database.

**"Continue with GitHub" doesn't appear** — both `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` must be set, and `github` must be in `apps/dashboard/void.json`'s `auth.providers` (it is by default).

**Artifacts fail to upload** — the R2 binding is auto-provisioned on deploy; if uploads 5xx, check `void project logs` and confirm the deploy completed. Per-artifact size is capped by `WRIGHTFUL_MAX_ARTIFACT_BYTES` (default 50 MiB).

---

## What's under the hood

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full architecture overview (single D1 + Drizzle, logical tenancy, R2 artifact storage, `void/live` realtime, streaming ingest protocol).
