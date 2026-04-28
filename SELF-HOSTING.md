# Self-hosting Wrightful

Wrightful runs entirely on Cloudflare: a single Worker for the dashboard + ingest API, one D1 database, one R2 bucket, two Durable Object classes. You can run it on your own account for free (Workers Free tier covers small teams) or on Workers Paid ($5/mo) for higher CPU/request limits.

There are two supported paths. Pick one:

- **[Path A: Fork + Cloudflare Git integration](#path-a-fork--cloudflare-git-integration-recommended)** — no terminal required after the initial fork. Updates flow via GitHub's "Sync fork" button. Recommended for most users.
- **[Path B: CLI-only](#path-b-cli-only)** — clone locally, use `wrangler` directly. Nice if you want full control or you're already a Cloudflare power user.

Both paths rely on Wrangler's [automatic resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/), so you never need to create a D1 or R2 manually.

---

## Path A: Fork + Cloudflare Git integration (recommended)

### 1. Fork the repo on GitHub

Click **Fork** on [`joefairburn/wrightful`](https://github.com/joefairburn/wrightful). Keep it public or make it private — both work.

### 2. Create the Worker in the Cloudflare dashboard

Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick your fork.

Build settings:

| Setting        | Value                                                                        |
| -------------- | ---------------------------------------------------------------------------- |
| Root directory | `packages/dashboard`                                                         |
| Build command  | `pnpm install --frozen-lockfile && pnpm --filter @wrightful/dashboard build` |
| Deploy command | `pnpm --filter @wrightful/dashboard run deploy:remote`                       |

`deploy:remote` is a staged deploy: it uploads the new Worker version without promoting it, applies D1 migrations against the new version's preview URL, and only then promotes the version to 100% traffic. If migrations fail, the previous version keeps serving — no broken deploy goes live. You never edit `wrangler.jsonc`. See step 4 for the full sequence.

You'll also need this build env var set in the Cloudflare Builds settings (Settings → Variables → Build):

- `MIGRATE_SECRET` — same value as the Worker secret of the same name (see step 3). The deploy script uses it to authenticate the post-upload migrate call.

Cloudflare runs the build on every push to your fork's default branch.

### 3. Set environment variables

In the Worker's **Settings → Variables and Secrets**, add:

**Required:**

- `WRIGHTFUL_PUBLIC_URL` (plain variable) — the URL your users will hit. Typically `https://wrightful.<your-account>.workers.dev` or a custom domain once you've set one up.
- `BETTER_AUTH_SECRET` (secret) — 32+ random bytes. Generate one with `openssl rand -base64 32` and paste it in.
- `MIGRATE_SECRET` (secret) — bearer token CI uses to apply D1 migrations after deploy via `POST /api/admin/migrate`. Generate another `openssl rand -base64 32` and paste it in. The same value must also be set as a build env var (see step 2) so the deploy command can authenticate.

**Optional:**

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (secrets) — enables "Continue with GitHub" on the sign-in page. Register an [OAuth app](https://github.com/settings/developers) with callback URL `${WRIGHTFUL_PUBLIC_URL}/api/auth/callback/github` and paste the values in.
- `ALLOW_OPEN_SIGNUP` (plain variable, set to `1`) — allow anyone to register. Off by default because email verification isn't wired up yet; leave off for public instances.

### 4. First deploy — auto-provisions D1 + R2 and applies migrations

Trigger a deploy (push to the fork's default branch or hit "Redeploy" in the dashboard). The deploy command runs three steps in order, designed so a failed migration leaves the previous version serving traffic:

1. **`wrangler versions upload`** — uploads the new Worker version _without promoting it_. The previously-deployed version keeps serving 100% of requests. On first run, Cloudflare auto-provisions a D1 database (binds as `DB`), an R2 bucket (binds as `R2`), and two Durable Object classes (`TenantDO`, `SyncedStateServer`).
2. **`POST <preview-url>/api/admin/migrate`** — the deploy script hits the _new version's_ preview URL with the `MIGRATE_SECRET` bearer token. The new code's migration list is what runs, against the live D1.
3. **`wrangler versions deploy <id>@100%`** — promotes the uploaded version. Only happens if step 2 succeeded.

If migrate fails, step 3 is skipped: the new version stays uploaded but dormant, the old version keeps serving traffic. Tenant DO migrations apply on first use automatically.

### 5. Sign up, create a team + project, seed an API key

Open your `WRIGHTFUL_PUBLIC_URL` in a browser.

1. **Sign up** with email/password (or GitHub if you configured it).
2. Go to `/admin/teams/new` and create a team.
3. Go to `/admin/t/<team-slug>/projects/new` and create a project.
4. Generate an API key for your CI:

```bash
pnpm --filter @wrightful/dashboard db:seed-api-key "ci-token" \
  --team <team-slug> --project <project-slug>
```

Save the printed key — only its SHA-256 hash is stored server-side.

### 6. Point the reporter at your instance

In your Playwright project's CI, set:

```bash
WRIGHTFUL_URL=https://wrightful.<your-account>.workers.dev
WRIGHTFUL_TOKEN=<the key from step 6>
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

## Path B: CLI-only

Prerequisites: Node 24+, `pnpm`, a Cloudflare account, `wrangler login` completed.

```bash
git clone https://github.com/<your-username>/wrightful.git
cd wrightful
pnpm install

# 1. Generate secrets
openssl rand -base64 32   # copy for BETTER_AUTH_SECRET
openssl rand -base64 32   # copy for MIGRATE_SECRET

# 2. Set secrets and vars on the Worker
pnpm --filter @wrightful/dashboard exec wrangler secret put BETTER_AUTH_SECRET
pnpm --filter @wrightful/dashboard exec wrangler secret put MIGRATE_SECRET
#   Paste each value when prompted.

# Set WRIGHTFUL_PUBLIC_URL once via the dashboard (Workers & Pages →
# your worker → Settings → Variables → add plain variable), or as a
# secret if you prefer:
pnpm --filter @wrightful/dashboard exec wrangler secret put WRIGHTFUL_PUBLIC_URL

# 3. Deploy — auto-provisions D1 + R2 on first run, then applies migrations.
# Export MIGRATE_SECRET so the post-deploy step can authenticate against
# the new version's preview URL.
export MIGRATE_SECRET=<paste the value from step 1>
pnpm --filter @wrightful/dashboard run deploy:remote
```

Then follow step 5 and step 6 from Path A to sign up and wire up the reporter.

---

## Updating your instance

### Path A (fork + Git integration)

When upstream ships a new release:

1. Open your fork on GitHub.
2. Click **Sync fork** at the top of the file list.
3. Cloudflare auto-deploys the new version within a minute. The deploy command runs migrations automatically.

Per-team Durable Object migrations apply on next access, also automatic.

### Path B (CLI)

```bash
git pull origin main
pnpm install
pnpm --filter @wrightful/dashboard run deploy:remote
```

---

## Environment variables reference

| Name                           | Required? | Where to set                             | Purpose                                                                                                            |
| ------------------------------ | --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `WRIGHTFUL_PUBLIC_URL`         | Yes       | Dashboard plain var (or secret)          | Public origin of the dashboard. Used by Better Auth for OAuth callbacks and artifact download token audiences.     |
| `BETTER_AUTH_SECRET`           | Yes       | Dashboard secret                         | Signs session cookies and artifact download tokens. 32+ random bytes.                                              |
| `MIGRATE_SECRET`               | Yes       | Dashboard secret + Build var             | Bearer token for the post-deploy `POST /api/admin/migrate` step. Worker secret and CF Builds build var must match. |
| `GITHUB_CLIENT_ID`             | No        | Dashboard secret                         | Enables "Continue with GitHub" sign-in.                                                                            |
| `GITHUB_CLIENT_SECRET`         | No        | Dashboard secret                         | Pair with `GITHUB_CLIENT_ID`.                                                                                      |
| `ALLOW_OPEN_SIGNUP`            | No        | Dashboard plain var (`1`/`0`)            | Allow public sign-up. Off by default.                                                                              |
| `WRIGHTFUL_MAX_ARTIFACT_BYTES` | No        | `wrangler.jsonc` `vars` (default 50 MiB) | Per-artifact upload size cap.                                                                                      |
| `WRIGHTFUL_RUN_STALE_MINUTES`  | No        | `wrangler.jsonc` `vars` (default 30)     | How long a run can sit `running` before the watchdog interrupts it.                                                |

---

## Troubleshooting

**First deploy 500s on sign-in pages** — `WRIGHTFUL_PUBLIC_URL` or `BETTER_AUTH_SECRET` isn't set. Check the Worker logs in the dashboard for the exact missing variable.

**Post-deploy migrate fails with 403** — `MIGRATE_SECRET` doesn't match between the Worker secret and the CF Builds build env var. They have to be set to the same string.

**Post-deploy migrate fails with 503** — `MIGRATE_SECRET` isn't configured on the Worker. Set it via `wrangler secret put MIGRATE_SECRET` (or under Settings → Variables and Secrets).

**"Migration is locked" / migrate hangs forever** — a previous attempt crashed between acquiring and releasing Kysely's migration lock. Reset it manually:

```bash
pnpm --filter @wrightful/dashboard exec wrangler d1 execute DB --remote \
  --command="UPDATE __migrations_lock SET is_locked = 0 WHERE id = 'migration_lock';"
```

Then redeploy.

**Recovering from a failed migration** — D1 has no transactions, so if a migration fails midway, the schema is partially applied (some `CREATE TABLE`s succeeded, the failing one didn't, anything after it didn't run). The new Worker version is unpromoted, so old code keeps serving — but if old code touches the partially-migrated tables, it can 500.

To recover:

1. **Inspect** the failure in the Cloudflare Builds log. The handler returns the failing statement.
2. **Fix** the migration (or hand-finish via `wrangler d1 execute`).
3. **Reset the lock** if it's stuck (see above).
4. **Redeploy.** The migrations use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` so previously-applied statements re-run as no-ops; the failing statement gets another chance.

For non-trivial recovery (e.g. a half-renamed column), it's easier to reset by manually executing the rest of the migration's SQL via `wrangler d1 execute --remote --file <path>`, then inserting a `__migrations` row by hand.

**Migration discipline** — write migrations that are _forward-compatible_ with the previous deployed version. Additive only (new tables, new nullable columns). Never drop or rename in the same migration as the code change that stops using it. The brief window between "new schema applied" and "new code promoted" means old code may run against a partially-migrated DB — additive-only migrations make that window safe.

**Sync fork shows a merge conflict** — you've edited a file that upstream also changed. The committed config (`wrangler.jsonc`, source, migrations) is designed so self-hosters don't need to edit it. If you customized anything intentionally, resolve the conflict on GitHub or via `git pull upstream main` locally.

**"Continue with GitHub" doesn't appear on the sign-in page** — both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must be set. Check the Worker's Variables tab.

**Artifacts fail to upload** — check the `R2` binding exists on your Worker (Settings → Bindings). The first deploy auto-creates it; if it's missing, trigger a redeploy.

---

## What's under the hood

See [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full architecture overview (control D1, tenant Durable Objects, artifact storage, streaming ingest protocol).
