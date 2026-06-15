# Self-hosting Wrightful

Wrightful's dashboard is a [Void](https://void.cloud) app that runs on Cloudflare Workers: one Worker for the dashboard + ingest API, a single D1 database (auth, tenancy, runs, and test data), and one R2 bucket for artifact bytes. It uses exactly two Cloudflare bindings — `DB` (D1) and `STORAGE` (R2); no KV.

There are two ways to deploy:

- **[Deploy to your own Cloudflare account](#recommended-deploy-to-your-own-cloudflare-account) (recommended)** — `wrangler deploy` against D1 + R2 resources you create. The build output is a standard Cloudflare Worker, so this is the most predictable, production-ready path today.
- **[One-command deploy with Void](#alternative-one-command-deploy-with-void-still-early) (simpler, still early)** — `void deploy` ships to Void's managed Cloudflare platform and auto-provisions everything with no Cloudflare account. The platform is young, so prefer the Cloudflare path above for anything you depend on.

Both produce the same Worker from the same checked-in migrations.

---

## Recommended: deploy to your own Cloudflare account

Prerequisites: Node 20+, `pnpm`, a Cloudflare account, and `wrangler` (`npm i -g wrangler`, then `wrangler login`).

```bash
git clone https://github.com/<your-username>/wrightful.git
cd wrightful
pnpm install
cd apps/dashboard          # the wrangler/build steps below run from here
```

### 1. Create the Cloudflare resources

```bash
wrangler d1 create wrightful-db          # prints a database_id — keep it for step 2
wrangler r2 bucket create wrightful-artifacts
```

### 2. Add the binding IDs to `wrangler.jsonc`

The repo ships `apps/dashboard/wrangler.jsonc` carrying the rate-limiter bindings. **Extend it** (don't replace it) with the D1 + R2 blocks, using the id from step 1 and keeping the binding names `DB` and `STORAGE`:

```jsonc
{
  // ...existing "name", "compatibility_date", "ratelimits"...
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "wrightful-db",
      "database_id": "<id from step 1>",
      "migrations_dir": "db/migrations",
    },
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "wrightful-artifacts" },
  ],
}
```

Void merges these (matched by binding name) with whatever it infers at build time. Don't add `main`, `assets`, or `migrations` — the plugin sets those.

### 3. Apply migrations to the remote D1

By database name (not the binding), so you can't apply to the wrong DB. This reads the `migrations_dir` from step 2:

```bash
wrangler d1 migrations apply wrightful-db --remote
```

### 4. Build and deploy

```bash
pnpm exec vite build      # writes dist/wrangler.json (your real IDs + Void's main/assets/triggers)
wrangler deploy           # ships it; prints your https://<worker>.<subdomain>.workers.dev URL
```

### 5. Set secrets

`wrangler secret put` applies to the live Worker immediately (no redeploy needed). Until they're set the dashboard 500s on sign-in pages — that's expected on first deploy.

```bash
openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET
wrangler secret put WRIGHTFUL_PUBLIC_URL     # paste the URL wrangler printed in step 4
```

Use the `workers.dev` URL from step 4, or a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) you map to the Worker. See [Environment variables](#environment-variables) for the optional keys (GitHub OAuth, open signup, etc.), then jump to [Sign up + wire up the reporter](#sign-up--wire-up-the-reporter).

### Updating

```bash
git pull origin main
pnpm install
cd apps/dashboard
wrangler d1 migrations apply wrightful-db --remote   # apply any new migrations first
pnpm exec vite build && wrangler deploy
```

### Auto-deploy on push (optional)

Add a GitHub Actions workflow with `CLOUDFLARE_API_TOKEN` (Workers Scripts + D1 + R2 edit scopes) and `CLOUDFLARE_ACCOUNT_ID` as repo secrets:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install
      - working-directory: apps/dashboard
        run: |
          pnpm exec wrangler d1 migrations apply wrightful-db --remote
          pnpm exec vite build
          pnpm exec wrangler deploy
```

Set the app secrets (`BETTER_AUTH_SECRET`, `WRIGHTFUL_PUBLIC_URL`, …) once with `wrangler secret put` — they persist across deploys.

---

## Alternative: one-command deploy with Void (still early)

> Void's managed deploy provisions D1 + R2 and applies migrations in a single command with **no Cloudflare account** — handy for a quick throwaway or preview instance. The platform is still early, so for anything you rely on, prefer the [Cloudflare path](#recommended-deploy-to-your-own-cloudflare-account) above.

Prerequisites: Node 20+, `pnpm`, a Void account.

```bash
pnpm install

# 1. Authenticate + link a Void project (interactive). Saves .void/project.json.
pnpm --filter @wrightful/dashboard exec void auth login

# 2. Set secrets (remote secrets persist across deploys).
openssl rand -base64 32 | pnpm --filter @wrightful/dashboard exec void secret put BETTER_AUTH_SECRET
pnpm --filter @wrightful/dashboard exec void secret put WRIGHTFUL_PUBLIC_URL

# 3. Deploy — builds, applies db/migrations/, provisions D1 + R2, goes live.
pnpm deploy
```

`pnpm deploy` runs `void deploy`, which reads the checked-in migrations from `apps/dashboard/db/migrations/`, fails if `db/schema.ts` has drifted ahead of them (run `void db generate`, commit, retry), applies any pending migrations, and goes live — no separate migrate step, no hand-edited binding config. For auto-deploy on push, `void init --github` writes a `.github/workflows/deploy.yml` that runs `void deploy` with a `VOID_TOKEN` secret (from `void auth token`).

---

## Environment variables

Every key is declared and validated in `apps/dashboard/env.ts`. For local dev, copy `apps/dashboard/.env.example` to `apps/dashboard/.env.local` and fill it in. For production, set values as secrets — `wrangler secret put NAME` (Cloudflare path) or `void secret put NAME` (Void path). A missing required key 500s the dashboard at runtime; `void deploy` additionally hard-errors before upload.

**Required:**

- `WRIGHTFUL_PUBLIC_URL` — the public origin users hit (e.g. `https://wrightful-dashboard-void.<you>.workers.dev` or a custom domain). Used by Better Auth for OAuth callbacks and for the artifact-download token audience.
- `BETTER_AUTH_SECRET` — 32+ random bytes (`openssl rand -base64 32`). Signs session cookies and artifact download tokens. (On Void's managed platform this is auto-created if unset.)

**Optional:**

- `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` — enable "Continue with GitHub". Register an [OAuth app](https://github.com/settings/developers) with callback `${WRIGHTFUL_PUBLIC_URL}/api/auth/callback/github`. Both must be set or the button stays hidden.
- `ALLOW_OPEN_SIGNUP` (`true`/`false`, default `false`) — allow anyone to register. Off by default; on a public instance, pair it with `EMAIL_FROM` so new registrations must verify their address before signing in. Left off, add users via invites.
- `EMAIL_FROM` — From address for outbound email (account verification, password reset, monitor alerts), e.g. `Wrightful <noreply@mail.example.com>`. Sent via the Cloudflare Email Service (CES) `EMAIL` binding, so the address must live on a domain you've [onboarded to CES](https://developers.cloudflare.com/email-service/) (CES provisions SPF/DKIM/DMARC). CES sending needs a Workers Paid plan and is in public beta. **Optional** — leave it unset and all email features stay off and degrade gracefully: signup needs no verification, the password-reset page reports email isn't configured, and monitor alerts are skipped.
- `ARTIFACT_TOKEN_SECRET` — optional dedicated signer for the short-lived artifact-download tokens. Defaults to `BETTER_AUTH_SECRET`; set a separate value to revoke leaked artifact links by rotating it, without invalidating every user session.
- `REALTIME_INTERNAL_SECRET` — pins the secret that authenticates the dashboard's internal realtime broadcasts (ingest worker → WebSocket room). Defaults to a fresh random value baked into each build; see [Production notes](#production-notes) for why you may want to pin it.

| Name                           | Required? | Default              | Purpose                                                                                                                |
| ------------------------------ | --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_PUBLIC_URL`         | Yes       | —                    | Public origin. OAuth callbacks + artifact download token audience.                                                     |
| `BETTER_AUTH_SECRET`           | Yes       | —                    | Signs session cookies + artifact download tokens. 32+ random bytes.                                                    |
| `ARTIFACT_TOKEN_SECRET`        | No        | `BETTER_AUTH_SECRET` | Dedicated signer for artifact download tokens — rotate to revoke leaked links without logging everyone out. 32+ bytes. |
| `AUTH_GITHUB_CLIENT_ID`        | No        | —                    | Enables "Continue with GitHub" sign-in.                                                                                |
| `AUTH_GITHUB_CLIENT_SECRET`    | No        | —                    | Pair with `AUTH_GITHUB_CLIENT_ID`.                                                                                     |
| `ALLOW_OPEN_SIGNUP`            | No        | `false`              | Allow public sign-up.                                                                                                  |
| `EMAIL_FROM`                   | No        | —                    | From address for verification / password-reset / monitor-alert email (Cloudflare Email Service). Unset = email off.    |
| `WRIGHTFUL_MAX_ARTIFACT_BYTES` | No        | 50 MiB               | Per-artifact upload size cap.                                                                                          |
| `WRIGHTFUL_RUN_STALE_MINUTES`  | No        | 30                   | How long a run can sit `running` before the cron watchdog interrupts it.                                               |
| `WRIGHTFUL_SWEEP_BATCH_SIZE`   | No        | 200                  | Max stale runs the watchdog finalizes per cron invocation.                                                             |
| `REALTIME_INTERNAL_SECRET`     | No        | per-build random     | Pins the internal realtime-broadcast secret across deploys. 32+ random bytes.                                          |

---

## Production notes

**Pin `REALTIME_INTERNAL_SECRET`** — the worker authenticates its internal realtime broadcasts (run/project live updates) with a secret that, by default, is a fresh random value baked into each build. During a rolling deploy, the old and new versions briefly hold different secrets, so cross-version broadcasts are rejected (a logged 403). This is non-fatal — the data is already in the database and live views catch up on reload — but if you deploy often and care about uninterrupted live updates, set a stable value once: `openssl rand -base64 32 | wrangler secret put REALTIME_INTERNAL_SECRET` (or `void secret put` on the Void path).

**Rate limiting needs a trusted client-IP header** — the auth/API rate limiters key unauthenticated requests by `CF-Connecting-IP`, falling back to the first hop of `X-Forwarded-For`. When the Worker runs on Cloudflare (both deploy paths above), `CF-Connecting-IP` is always set by the edge and cannot be spoofed. If you front the instance with anything else — or proxy to it through your own infrastructure — note that `X-Forwarded-For` is client-controlled: a sender can rotate it freely to dodge per-IP limits. Make sure your edge sets `CF-Connecting-IP` (or strips and rewrites `X-Forwarded-For`) from the real client address before the request reaches the Worker.

**What "closed signup" actually closes** — with `ALLOW_OPEN_SIGNUP=false`, email/password registration is disabled, but GitHub OAuth sign-in (when configured) can still create accounts. That is deliberate: invites don't create accounts, so OAuth signup is how an invited teammate gets one on a closed instance. The resource boundary is enforced one step later — a self-registered account with no team membership cannot **create a team** (and therefore can't reach projects, API keys, or synthetic monitors). The only exception is a fresh instance with zero teams, so the first user — you — can bootstrap. Existing members can always create additional teams.

**Email is optional (`EMAIL_FROM`)** — account verification, password reset, and monitor down/recovery alerts only send when `EMAIL_FROM` is set and its domain is onboarded to Cloudflare Email Service. Without it the dashboard runs normally: signup skips verification (so a public instance with open signup but no email lets anyone in unverified — set `EMAIL_FROM` for public instances), the password-reset page reports that email isn't configured, and monitor alerts are silently skipped. In local `vp dev` the send is **simulated** — logged to the console with the rendered HTML/text written to a temp file — so you never send real mail while developing.

---

## Sign up + wire up the reporter

Open your `WRIGHTFUL_PUBLIC_URL` in a browser.

1. **Sign up** with email/password (or GitHub if configured). Set `ALLOW_OPEN_SIGNUP=true` first if you're the first user, then turn it off.
2. Create a team via `/settings/teams/new`.
3. Create a project via `/settings/teams/<team-slug>/projects/new`.
4. Generate an API key from the project's keys page (`/settings/teams/<team-slug>/p/<project-slug>/keys`). Save the printed key — only its SHA-256 hash is stored server-side.

In your Playwright project's CI, set:

```bash
WRIGHTFUL_URL=https://<your-dashboard-origin>
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

## Troubleshooting

**First load 500s on sign-in pages** — `WRIGHTFUL_PUBLIC_URL` or `BETTER_AUTH_SECRET` isn't set. List what's set with `wrangler secret list` (or `void env check --remote` on the Void path); tail runtime logs with `wrangler tail` (or `void project logs --level error`).

**Schema drift on build/deploy** — `db/schema.ts` is ahead of the committed migrations. Run `void db generate`, review the new file in `apps/dashboard/db/migrations/`, and commit it. On the Cloudflare path, re-apply with `wrangler d1 migrations apply wrightful-db --remote` then redeploy; `void deploy` applies pending migrations itself.

**Migration discipline** — schema changes are forward-only / additive (new tables, new nullable columns). Generate a new numbered migration with `void db generate`; never edit a migration that has already been applied to a live database.

**"Continue with GitHub" doesn't appear** — both `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` must be set; the button is gated on both being present. The provider is enabled in `apps/dashboard/auth.ts` at startup when those creds exist — it is deliberately **not** declared in `apps/dashboard/void.json`'s `auth.providers` (which lists only `email`), because declaring it there would make Void hard-require the GitHub creds on every deploy.

**Artifacts fail to upload** — confirm the `STORAGE` (R2) binding resolved. On the Cloudflare path the `r2_buckets` block must be present in `wrangler.jsonc` with a real `bucket_name`; tail logs with `wrangler tail`. Per-artifact size is capped by `WRIGHTFUL_MAX_ARTIFACT_BYTES` (default 50 MiB).

---

## What's under the hood

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full architecture overview (single D1 + Drizzle, logical tenancy, R2 artifact storage, `void/live` realtime, streaming ingest protocol). For the exact binding-merge semantics on the Cloudflare path, see the Void [Cloudflare integration guide](https://void.cloud/integrations/cloudflare#deploy-to-your-own-cloudflare-account).
