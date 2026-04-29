# Wrightful — Open Source Playwright Dashboard on Cloudflare

> An open-source Playwright test reporter and analytics dashboard that anyone can self-host on Cloudflare for free.

This document is the strategy + decisions doc — what Wrightful is, what it isn't, and why we made the architectural calls we did. For the request flow, storage layout, and route surface as they stand today, see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). For self-hosting steps, see [`SELF-HOSTING.md`](../SELF-HOSTING.md). For the dated narrative behind specific changes, see [`docs/worklog/`](./worklog/).

## Problem

Playwright's built-in HTML reporter is excellent for debugging a single run, but has no persistence, no cross-run analytics, no flaky test detection, and no team sharing beyond downloading zip artifacts from CI. The only solutions are commercial dashboards starting at $49/month (Currents.dev, TestDino). There is no credible open-source alternative that provides historical test analytics with a simple self-hosting story.

Microsoft shutting down Playwright Testing's reporting dashboard (March 2026) widens this gap further.

## Vision

A lightweight, self-hostable Playwright dashboard that solves three specific problems:

1. **Sharded run fragmentation** — merge results from N CI shards into a single unified view
2. **No historical memory** — track test results over time to answer "is this test getting flakier?" and "is our suite getting slower?"
3. **Flaky test blindness** — automatically detect and surface flaky tests based on pass/fail patterns across runs

Non-goals (explicitly out of scope):

- Smart test orchestration (dynamic test distribution across CI machines)
- AI-powered failure classification
- Replacing the Playwright HTML report for single-run debugging
- Support for non-Playwright test runners (Vitest, Jest) — Playwright-specific features like traces, annotations, and projects are core differentiators

## Tech Stack

| Layer          | Technology                                          | Why                                                                                                                                               |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | **RedwoodSDK**                                      | Server-first React on Cloudflare. RSC means routes can query the data layer directly and return JSX — no separate API layer needed for the UI.    |
| Auth/tenancy   | **Singleton `ControlDO`** + **Better Auth**         | SQLite-backed Durable Object holds users, sessions, teams, projects, memberships, API keys. Addressed by name `"control"`; one instance globally. |
| Tenant data    | **Per-team `TenantDO`**                             | One SQLite-backed Durable Object per team holds runs + derived rows. Physical tenant isolation, addressed by `idFromName(teamId)`.                |
| Realtime       | **`SyncedStateServer` DO**                          | rwsdk's stock realtime DO; broadcasts run-progress snapshots to subscribed dashboard clients.                                                     |
| Query builder  | **Kysely**                                          | Same builder, two stores. Schema for each DO is defined as a Kysely-DSL migration; types are inferred from the migration with `Database<typeof>`. |
| Object storage | **Cloudflare R2**                                   | S3-compatible storage for traces, screenshots, videos. 10GB free, zero egress charges. Artifacts uploaded and downloaded via presigned URLs.      |
| Reporter       | **`@wrightful/reporter`**                           | Custom Playwright reporter that streams per-test results live as the suite runs (open run → append batches → complete). Not a JSON-file uploader. |
| CI integration | **GitHub Action** (planned)                         | Optional action that posts PR comments with run summary, flaky warnings, and dashboard link.                                                      |
| API auth       | **Bearer API keys**                                 | Per-project keys, SHA-256 hashed at rest, looked up by 8-char prefix. Multiple keys per project with individual revocation.                       |
| Dashboard auth | **Better Auth** (sessions; email + optional GitHub) | Email/password sign-in by default, optional GitHub OAuth. Session cookie + middleware (`loadSession`, `requireUser`) gate the UI.                 |

### Why RedwoodSDK over Hono + React SPA

- RSC removes the need to build and maintain a separate REST API for the dashboard — a route handler queries the data layer and returns JSX directly
- Built-in DO, R2, Queues, Crons bindings with no config
- Vite-based, so the dev experience is fast and familiar
- Server Functions for mutations (no manual fetch/POST wiring)
- Still React — leverages existing knowledge
- Stable framework purpose-built for Cloudflare Workers

### Why Durable Objects over D1

The original design used a single Cloudflare D1 database for everything. Two pressures pushed us off that path:

1. **Per-tenant data partitioning.** Running every team's runs/results/artifacts through one D1 single-writer instance makes the noisy-neighbour problem inevitable. Sharding by team into per-team `TenantDO` instances gives each team its own SQLite + its own write throughput, and makes tenant isolation physical rather than conventional. See [`docs/worklog/2026-04-20-per-tenant-durable-objects.md`](./worklog/2026-04-20-per-tenant-durable-objects.md).
2. **Auto-provisioning friction for self-hosters.** Cloudflare's binding-resolution behaviour for newly-created D1 databases meant the first deploy needed a multi-step migrate orchestration with a side-channel `MIGRATE_SECRET`. Moving auth/tenancy into a singleton `ControlDO` removed the orchestration entirely — `wrangler deploy` provisions the DOs and each migrates lazily on first request. See [`docs/worklog/2026-04-29-control-do.md`](./worklog/2026-04-29-control-do.md).

The trade-off accepted: auth lookups now hit a single DO (region-pinned) rather than a read-replicated D1. The dashboard hot path takes a ~200–400ms latency hit for distant users; ingest is unaffected. KV-caching session reads is the deferred mitigation if traffic ever justifies it.

## Architecture

For the canonical view, see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). One-paragraph summary:

A single Cloudflare Worker hosts both the streaming ingest API (`/api/runs/*`, `/api/artifacts/*`) and the RSC dashboard UI (`/t/:teamSlug/p/:projectSlug/…`). API requests authenticate with a project-scoped Bearer key; dashboard requests carry a Better Auth session cookie. Auth/tenancy reads/writes go to the singleton `ControlDO`; runs and derived rows go to the team-scoped `TenantDO`; artifact bytes go to R2 via presigned PUT/GET. Realtime progress is fanned out via a `SyncedStateServer` DO that the run-detail and run-list client islands subscribe to.

### Streaming ingest flow

The reporter doesn't dump a JSON file at the end of the suite — it streams. Three phases:

- `onBegin` → `POST /api/runs` opens the run. The reporter declares the planned test list and gets back a `runId`.
- `onTestEnd` → buffer per test until all retries are settled, then `POST /api/runs/:runId/results` in batches. Each response returns `clientKey → testResultId`, which the reporter uses to register and PUT artifacts via `POST /api/artifacts/register` + presigned R2 URLs.
- `onEnd` → `POST /api/runs/:runId/complete` sets the terminal status.

Per-test emission means one row per test at its final outcome, with retries aggregated into `flaky`. Wire types live in both `packages/reporter/src/types.ts` (TypeScript) and `packages/dashboard/src/routes/api/schemas.ts` (Zod) — keep them in sync.

### Multi-tenancy

Teams → projects → runs (+ derived rows). Users join teams via `memberships` (`owner` | `member`). Tenant isolation is physical — each team gets its own `TenantDO` instance. Within a team's DO, queries against `runs` / `testResults` / `testResultAttempts` / `testTags` / `testAnnotations` / `artifacts` must still filter by `projectId`; the branded `AuthorizedProjectId` on `TenantScope` makes that hard to forget at the type level. Auth helpers (`tenantScopeForUser`, `tenantScopeForApiKey`, `getActiveProject`) gate every read/write — no route handler should reach raw bindings.

### Stable test ID

`testId` is a hash of `file + titlePath + projectName` — this is how we track the same test across runs. Playwright's internal `test.id` changes between runs, so we need our own stable identifier.

**Known limitations** (document prominently in user-facing docs):

- Renaming a `describe` block breaks every test ID inside it
- Fixing a typo in a test title creates a "new" test and orphans the old history
- Moving a test between files breaks tracking
- Changing the Playwright project name breaks tracking

This is the same approach used by Currents.dev and TestDino. The tradeoff is acceptable — these are infrequent operations, and the alternative (fuzzy matching) introduces its own class of bugs.

### Idempotency

The reporter generates an idempotency key per run (e.g. derived from `GITHUB_RUN_ID` so shards converge on the same run). The open-run endpoint checks the key:

- If the key doesn't exist: insert normally, return `201 Created`
- If the key already exists: return `200 OK` with the existing run ID, skip insertion
- This makes retries safe — a flaky network in CI won't create duplicate runs

### Protocol versioning

Reporter requests carry `X-Wrightful-Version`. Currently only version 3 is supported — older reporters/CLIs get a 409 with a clear upgrade message. The version increments when the request/response schema changes in a backwards-incompatible way; additive changes (new optional fields) do not.

## Dashboard pages

### Core views

1. **Team picker** (`/`)
   - Lists teams the signed-in user is a member of; landing page.

2. **Runs list** (`/t/:teamSlug/p/:projectSlug`)
   - Table: branch, commit, status (pass/fail), test counts, duration, timestamp
   - Filter by branch, status, date range, tags
   - Shard-aware: groups shards by `ciBuildId` (extracted from CI env), shows merged totals

3. **Run detail** (`/t/:teamSlug/p/:projectSlug/runs/:runId`)
   - Summary: pass/fail/flaky/skipped counts, total duration, commit info
   - Test list: sortable by status, duration, name; filterable by tag
   - In-flight runs: realtime progress via `useSyncedState` subscribed to the `SyncedStateServer` DO
   - Sharded runs: per-shard breakdown alongside merged totals

4. **Test detail** (`/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId`)
   - Error message + stack trace (syntax highlighted)
   - Artifacts: trace viewer link via `trace.playwright.dev`, screenshots inline, video player
   - Retry history within this run (one row per attempt)
   - Tags and annotations
   - Link to historical view of this test

5. **Test history** (per-test cross-run view)
   - Sparkline: pass/fail/flaky over last N runs
   - Duration trend chart
   - Flakiness percentage over configurable windows (7d, 30d, 90d)

6. **Flaky tests**
   - Ranked list of tests by flakiness rate
   - Filters: time window, branch (default: main/master), minimum run count, tags

7. **Settings**
   - Team management, project management, member invites, API keys
   - Per-project key reveal flow: minted plaintext returned once via the `wrightful_reveal_key` Set-Cookie header.

### Nice-to-have views (post-MVP)

- **Insights** — suite duration trend, top 10 slowest tests, pass rate trend, duration regression detection
- **Branch comparison** — compare test results between two branches
- **PR view** — all runs associated with a PR, with status timeline
- **Notifications** — webhook on flaky test threshold breach

## GitHub Integration (planned)

A lightweight GitHub Action that runs after the reporter finishes posts a PR comment with a summary table and link back to the dashboard. Fork PRs cannot access repository secrets, so the action degrades gracefully — skip the comment and log a warning rather than fail the workflow.

## Self-hosting

See [`SELF-HOSTING.md`](../SELF-HOSTING.md) for the canonical step-by-step guide. In one paragraph: deploy via Cloudflare's Git integration (preferred) or `wrangler deploy` directly; Wrangler auto-provisions the R2 bucket and the three DO classes (`ControlDO`, `TenantDO`, `SyncedStateServer`) on first run, each DO migrates itself lazily on first access, then you sign up via the dashboard, create a team + project, and mint an API key from the project's keys page. No D1 database to create, no migration step to run, no `MIGRATE_SECRET` to manage.

**Cloudflare free tier** (Workers Free) covers most small-to-medium teams. Heavy users upgrade to Workers Paid ($5/month) for higher CPU/request limits and bigger DO storage budgets.

## Key Design Decisions

### Streaming reporter, not a JSON-file uploader

The original plan was a CLI that reads Playwright's built-in JSON report after the suite ends. We switched to a streaming Reporter implementation because (1) streaming matches the dashboard's realtime progress model — users see results live as tests complete, not after the suite ends, and (2) the per-test emission cadence integrates more cleanly with sharded CI than a single end-of-suite POST.

### Per-shard streaming, dashboard merges

Each CI shard's reporter streams independently. The dashboard groups shards by idempotency key (derived from CI env vars like `GITHUB_RUN_ID`) and presents merged views. No merge step required in CI; works naturally with any CI system that exposes a build/run ID.

### Stable test IDs via hashing

Playwright's internal `test.id` is not stable across runs. We generate our own by hashing `file + titlePath + projectName`. This enables cross-run tracking but means renamed/moved tests appear as new tests. See "Known limitations" above.

### Artifacts only for failures (default)

To keep R2 storage manageable, the default reporter config uploads traces/screenshots/videos only for failed and flaky tests. Users can override with `artifacts: 'all'`. This matches Playwright's recommended `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` config.

### Presigned R2 URLs for artifact serving

Artifacts upload directly from the reporter to R2 (presigned PUT) and are served from R2 to the browser (signed token containing the R2 key). The Worker is never in the byte path. This avoids Worker CPU time on large files and avoids the response-size cap.

### RSC for dashboard pages

Every dashboard page is a React Server Component that queries the data layer directly. No client-side data fetching, no loading spinners, no REST API to maintain for the UI. Client islands only for interactive bits: charts, sortable tables, filter dropdowns, realtime progress subscriptions.

### Multiple API keys from day one

Instead of a single shared secret, each project supports multiple labelled API keys. Keys are SHA-256 hashed at rest and individually revocable. This avoids the painful migration from "one key" to "many keys" that would otherwise be needed when a key leaks or a pipeline is decommissioned.

### Tags and annotations as first-class tables

Tags and annotations are stored in dedicated tables (`testTags`, `testAnnotations`) rather than JSON strings, so they can be filtered and joined efficiently. Adds insertion complexity but is essential for the "filter by tag" feature on run detail and flaky test pages.

### Pre-launch migration policy

Both `ControlDO` and `TenantDO` schemas live as a single `0000_init` Kysely-DSL migration each. Pre-launch policy: edit `0000_init` in place and redeploy on schema changes; don't stack numbered migrations. This avoids accumulating migration debt during the rapid-iteration phase. Once the project ships to non-test users, the policy flips to additive-only migrations.

## Decisions (Resolved)

| Question                                | Decision           | Rationale                                                                                                                         |
| --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Support non-Playwright runners?         | No                 | Playwright-specific features (traces, annotations, projects) are core differentiators. Generalization would dilute the product.   |
| Single D1 vs per-tenant DO + ControlDO? | DO-only            | Per-tenant write isolation, simpler self-hosting story (no D1 auto-provisioning friction). Trade-off: single-region auth latency. |
| CLI uploader vs streaming reporter?     | Streaming reporter | Matches the dashboard's realtime model; per-test emission integrates cleanly with sharded CI.                                     |
| Drizzle vs Kysely?                      | Kysely             | Same builder works for both DOs (no D1-specific adapter); types inferred from migration DSL; lighter dep surface.                 |
| Bring-your-own-Postgres alternative?    | No                 | Split maintenance focus kills OSS projects. Community contribution if demand exists.                                              |
| License                                 | MIT                | Lower friction for adoption, matches Playwright itself.                                                                           |
| Monorepo tooling                        | pnpm workspaces    | Skip Turborepo unless pain is felt — overhead for 3 packages.                                                                     |
| Naming                                  | Wrightful          | Rebranded from "Greenroom" on 2026-04-16. Short, memorable, pairs with the `wrightful.dev` domain.                                |
