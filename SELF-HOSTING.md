# Self-hosting Wrightful

Wrightful runs entirely on Cloudflare: a single Worker for the dashboard + ingest API, one R2 bucket, three Durable Object classes (one for auth/tenancy, one per team for tenant data, one for realtime fan-out). You can run it on your own account for free (Workers Free tier covers small teams) or on Workers Paid ($5/mo) for higher CPU/request limits.

There are two supported paths. Pick one:

- **[Path A: Fork + Cloudflare Git integration](#path-a-fork--cloudflare-git-integration-recommended)** — no terminal required after the initial fork. Updates flow via GitHub's "Sync fork" button. Recommended for most users.
- **[Path B: CLI-only](#path-b-cli-only)** — clone locally, use `wrangler` directly. Nice if you want full control or you're already a Cloudflare power user.

Both paths rely on Wrangler's [automatic resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/), so you never need to create resources manually.

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

`deploy:remote` runs `wrangler deploy`. Cloudflare auto-provisions the R2 bucket and all three Durable Object classes (`ControlDO`, `TenantDO`, `SyncedStateServer`) on first run; schema migrations run lazily inside each DO on first access via [rwsdk's `SqliteDurableObject` pattern](https://docs.rwsdk.com/) — no separate migrate step. You never edit `wrangler.jsonc`.

Cloudflare runs the build on every push to your fork's default branch.

### 3. Set environment variables

In the Worker's **Settings → Variables and Secrets**, add:

**Required:**

- `WRIGHTFUL_PUBLIC_URL` (plain variable) — the URL your users will hit. Typically `https://wrightful.<your-account>.workers.dev` or a custom domain once you've set one up.
- `BETTER_AUTH_SECRET` (secret) — 32+ random bytes. Generate one with `openssl rand -base64 32` and paste it in.

**Optional:**

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (secrets) — enables "Continue with GitHub" on the sign-in page. Register an [OAuth app](https://github.com/settings/developers) with callback URL `${WRIGHTFUL_PUBLIC_URL}/api/auth/callback/github` and paste the values in.
- `ALLOW_OPEN_SIGNUP` (plain variable, set to `1`) — allow anyone to register. Off by default because email verification isn't wired up yet; leave off for public instances.

### 4. First deploy — auto-provisions everything

Trigger a deploy (push to the fork's default branch or hit "Redeploy" in the dashboard). On first run, Cloudflare auto-provisions:

- An R2 bucket (binds as `R2`).
- Three Durable Object classes — `ControlDO` (singleton, holds users/teams/projects/sessions/api keys), `TenantDO` (one per team, holds runs and test results), `SyncedStateServer` (realtime fan-out).

ControlDO migrations run automatically on the first request that touches it (sign-up, sign-in, etc.). TenantDO migrations run on first access per team.

### 5. Sign up, create a team + project, mint an API key

Open your `WRIGHTFUL_PUBLIC_URL` in a browser.

1. **Sign up** with email/password (or GitHub if you configured it). Enable `ALLOW_OPEN_SIGNUP=1` first if needed.
2. Create a team via `/settings/teams/new`.
3. Create a project via `/settings/teams/<team-slug>/projects/new`.
4. Generate an API key from the project's keys page (`/settings/teams/<team-slug>/p/<project-slug>/keys`).

Save the printed key — only its SHA-256 hash is stored server-side.

### 6. Point the reporter at your instance

In your Playwright project's CI, set:

```bash
WRIGHTFUL_URL=https://wrightful.<your-account>.workers.dev
WRIGHTFUL_TOKEN=<the key from step 5>
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

# 1. Generate the auth secret.
openssl rand -base64 32   # copy for BETTER_AUTH_SECRET

# 2. Set secrets and vars on the Worker.
pnpm --filter @wrightful/dashboard exec wrangler secret put BETTER_AUTH_SECRET
#   Paste the value when prompted.

# Set WRIGHTFUL_PUBLIC_URL once via the dashboard (Workers & Pages →
# your worker → Settings → Variables → add plain variable), or as a
# secret if you prefer:
pnpm --filter @wrightful/dashboard exec wrangler secret put WRIGHTFUL_PUBLIC_URL

# 3. Deploy. Auto-provisions R2 + DOs on first run; migrations run lazily
# inside each DO on first access.
pnpm --filter @wrightful/dashboard run deploy:remote
```

Then follow step 5 and step 6 from Path A to sign up and wire up the reporter.

---

## Updating your instance

### Path A (fork + Git integration)

When upstream ships a new release:

1. Open your fork on GitHub.
2. Click **Sync fork** at the top of the file list.
3. Cloudflare auto-deploys the new version within a minute. Schema migrations apply lazily on next access to each DO — no manual step.

### Path B (CLI)

```bash
git pull origin main
pnpm install
pnpm --filter @wrightful/dashboard run deploy:remote
```

---

## Environment variables reference

| Name                           | Required? | Where to set                             | Purpose                                                                                                        |
| ------------------------------ | --------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_PUBLIC_URL`         | Yes       | Dashboard plain var (or secret)          | Public origin of the dashboard. Used by Better Auth for OAuth callbacks and artifact download token audiences. |
| `BETTER_AUTH_SECRET`           | Yes       | Dashboard secret                         | Signs session cookies and artifact download tokens. 32+ random bytes.                                          |
| `GITHUB_CLIENT_ID`             | No        | Dashboard secret                         | Enables "Continue with GitHub" sign-in.                                                                        |
| `GITHUB_CLIENT_SECRET`         | No        | Dashboard secret                         | Pair with `GITHUB_CLIENT_ID`.                                                                                  |
| `ALLOW_OPEN_SIGNUP`            | No        | Dashboard plain var (`1`/`0`)            | Allow public sign-up. Off by default.                                                                          |
| `WRIGHTFUL_MAX_ARTIFACT_BYTES` | No        | `wrangler.jsonc` `vars` (default 50 MiB) | Per-artifact upload size cap.                                                                                  |
| `WRIGHTFUL_RUN_STALE_MINUTES`  | No        | `wrangler.jsonc` `vars` (default 30)     | How long a run can sit `running` before the watchdog interrupts it.                                            |

---

## Troubleshooting

**First deploy 500s on sign-in pages** — `WRIGHTFUL_PUBLIC_URL` or `BETTER_AUTH_SECRET` isn't set. Check the Worker logs in the dashboard for the exact missing variable.

**Migration discipline** — schema changes are forward-only / additive (new tables, new nullable columns). Never drop or rename in the same migration as the code change that stops using it. Pre-launch policy: edit the existing `0000_init` migration in place rather than stacking numbered migrations.

**Sync fork shows a merge conflict** — you've edited a file that upstream also changed. The committed config (`wrangler.jsonc`, source) is designed so self-hosters don't need to edit it. If you customized anything intentionally, resolve the conflict on GitHub or via `git pull upstream main` locally.

**"Continue with GitHub" doesn't appear on the sign-in page** — both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must be set. Check the Worker's Variables tab.

**Artifacts fail to upload** — check the `R2` binding exists on your Worker (Settings → Bindings). The first deploy auto-creates it; if it's missing, trigger a redeploy.

---

## What's under the hood

See [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full architecture overview (ControlDO, tenant Durable Objects, artifact storage, streaming ingest protocol).
