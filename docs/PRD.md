# Greenroom — Open Source Playwright Dashboard on Cloudflare

> An open-source Playwright test reporter and analytics dashboard that anyone can self-host on Cloudflare for free. Built with RedwoodSDK, D1, R2, and Drizzle.

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
- Real-time WebSocket streaming during test execution
- AI-powered failure classification
- Replacing the Playwright HTML report for single-run debugging
- Support for non-Playwright test runners (Vitest, Jest) — Playwright-specific features like traces, annotations, and projects are core differentiators

## Tech Stack

| Layer          | Technology                          | Why                                                                                                                                                                                            |
| -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | **RedwoodSDK**                      | Server-first React on Cloudflare. RSC means routes can query D1 directly and return JSX — no separate API layer needed. Vite plugin, local dev runs on actual `workerd` runtime via Miniflare. |
| Database       | **Cloudflare D1** + **Drizzle ORM** | SQLite at the edge. 500MB free, 10GB on $5/month plan. Drizzle has first-class D1 support with migrations.                                                                                     |
| Object Storage | **Cloudflare R2**                   | S3-compatible storage for traces, screenshots, videos. 10GB free, zero egress charges ever. Artifacts served via presigned URLs.                                                               |
| CLI            | **`@greenroom/cli`**                | Reads Playwright's JSON report output, transforms and uploads to the dashboard API. Handles artifact collection and upload.                                                                    |
| CI Integration | **GitHub Action**                   | Optional action that posts PR comments with run summary, flaky warnings, and dashboard link.                                                                                                   |
| Auth           | **API key**                         | Multiple API keys with labels, stored as hashed values in D1. One key per pipeline/repo/environment.                                                                                           |

### Why RedwoodSDK over Hono + React SPA

- RSC removes the need to build and maintain a separate REST API — a route handler queries D1 and returns JSX directly
- Built-in D1, R2, Queues, Crons bindings with no config
- Vite-based, so the dev experience is fast and familiar
- Server Functions for mutations (no manual fetch/POST wiring)
- Still React — leverages existing knowledge
- Stable framework purpose-built for Cloudflare Workers

## Architecture

```
┌─────────────────────┐     ┌──────────────────────────────────┐
│   CI (GitHub Actions)│     │   Cloudflare (self-hosted)       │
│                      │     │                                  │
│  Playwright tests    │     │  ┌────────────────────────────┐  │
│  + JSON reporter     │     │  │  RedwoodSDK Worker         │  │
│                      │     │  │                            │  │
│  npx @greenroom/cli  │────▶│  │  /api/ingest — receives    │  │
│    upload            │POST │  │    test results (batch)    │  │
│    ./playwright-json │     │  │  /api/artifacts — receives │  │
│    --token=abc       │────▶│  │    binary uploads → R2     │  │
│                      │PUT  │  │                            │  │
│  Shards upload       │     │  │  /* — dashboard UI (RSC)   │  │
│  independently       │     │  └──────────┬─────────┬───────┘  │
│  (merged by          │     │             │         │          │
│   ciBuildId)         │     │        ┌────▼───┐ ┌──▼───┐     │
│                      │     │        │  D1    │ │  R2  │     │
│                      │     │        │(SQLite)│ │(Blob)│     │
└─────────────────────┘     │        └────────┘ └──────┘     │
                            │                                  │
┌─────────────────────┐     │  Artifacts served via            │
│   Browser            │◀────│  presigned R2 URLs               │
│   (dashboard UI)     │     │                                  │
└─────────────────────┘     └──────────────────────────────────┘
```

### CLI Upload Approach (not a custom Reporter)

Instead of implementing Playwright's `Reporter` interface, Greenroom uses a CLI that reads Playwright's built-in JSON reporter output:

1. User adds `['json', { outputFile: 'playwright-report.json' }]` to their Playwright config's reporter list
2. After tests complete, user runs: `npx @greenroom/cli upload ./playwright-report.json --token=abc --url=https://your-dashboard.example.com`
3. The CLI parses the JSON report, computes stable test IDs, and batch-POSTs structured data to `/api/ingest`
4. The CLI then collects and uploads artifacts (traces, screenshots, videos) to `/api/artifacts`

**Why this over a custom Reporter:**

- Zero coupling to Playwright's Reporter API internals — JSON output format is stable and well-documented
- Simpler mental model for users: run tests, then upload results as a separate step
- Easier to test and debug — the JSON file is inspectable
- Works naturally in CI: the upload step is a distinct pipeline stage
- No Node.js-specific dependency injection — could theoretically be rewritten in any language

### Shard Merging (Workflow A: Per-Shard Upload)

Each CI shard runs tests and produces its own JSON report. Each shard independently uploads to the dashboard via the CLI. The dashboard groups shards by `ciBuildId` (extracted from CI environment variables like `GITHUB_RUN_ID`) and presents a merged view.

- No merge step required in CI — each shard uploads independently
- Dashboard aggregates pass/fail/flaky/skipped counts across shards sharing the same `ciBuildId`
- Run detail page shows per-shard breakdown alongside merged totals
- Tradeoff: the dashboard must handle the merge logic, but this is simpler than requiring users to set up a separate merge step in CI

### D1 Write Throughput Constraint

D1 is single-writer (~100–300 inserts/sec). Mitigations:

- **Batch all test results** from a shard into a single POST payload
- D1 batch transactions are limited to **1000 statements**. For runs with >1000 tests, the ingest endpoint chunks into multiple batch transactions within a single request
- A run with 500 tests = ~50–100KB of structured JSON = one API call, one or more batch inserts
- If needed later, use Cloudflare Queues to buffer writes during traffic spikes
- Binary artifacts go to R2, never D1

### D1 Storage Budget

- 500 tests/run × 200 bytes/row = 100KB per run (test results only, tags/annotations add ~20%)
- 20 runs/day × 365 days = ~730MB/year of structured data
- Well within the 10GB cap on the $5/month plan
- Implement TTL-based cleanup (configurable retention, default 90 days) via Cron Trigger

## Data Model (Drizzle Schema)

```typescript
// schema.ts

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(), // ulid
  label: text("label").notNull(), // e.g. "github-actions-main", "local-dev"
  keyHash: text("key_hash").notNull(), // bcrypt or SHA-256 hash of the raw key
  keyPrefix: text("key_prefix").notNull(), // first 8 chars for identification in UI
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), // ulid
  idempotencyKey: text("idempotency_key").unique(), // client-generated, prevents duplicate uploads
  ciProvider: text("ci_provider"), // 'github-actions', 'gitlab-ci', etc.
  ciBuildId: text("ci_build_id"), // links shards together (e.g. GITHUB_RUN_ID)
  branch: text("branch"),
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),
  prNumber: integer("pr_number"),
  repo: text("repo"),
  shardIndex: integer("shard_index"),
  shardTotal: integer("shard_total"),
  totalTests: integer("total_tests").notNull(),
  passed: integer("passed").notNull(),
  failed: integer("failed").notNull(),
  flaky: integer("flaky").notNull(),
  skipped: integer("skipped").notNull(),
  durationMs: integer("duration_ms").notNull(),
  status: text("status").notNull(), // 'passed' | 'failed' | 'timedout' | 'interrupted'
  reporterVersion: text("reporter_version"),
  playwrightVersion: text("playwright_version"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const testResults = sqliteTable("test_results", {
  id: text("id").primaryKey(), // ulid
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  testId: text("test_id").notNull(), // stable hash of file + title path + projectName (for cross-run tracking)
  title: text("title").notNull(), // full title path: "Payment flow > should complete checkout"
  file: text("file").notNull(), // relative file path
  projectName: text("project_name"), // playwright project (chromium, firefox, etc.)
  status: text("status").notNull(), // 'passed' | 'failed' | 'flaky' | 'skipped' | 'timedout'
  durationMs: integer("duration_ms").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
  workerIndex: integer("worker_index"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const testTags = sqliteTable("test_tags", {
  id: text("id").primaryKey(), // ulid
  testResultId: text("test_result_id")
    .notNull()
    .references(() => testResults.id, { onDelete: "cascade" }),
  tag: text("tag").notNull(), // e.g. "@smoke", "@regression", "@payments"
});

export const testAnnotations = sqliteTable("test_annotations", {
  id: text("id").primaryKey(), // ulid
  testResultId: text("test_result_id")
    .notNull()
    .references(() => testResults.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // e.g. "fixme", "slow", "issue"
  description: text("description"),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(), // ulid
  testResultId: text("test_result_id")
    .notNull()
    .references(() => testResults.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'trace' | 'screenshot' | 'video' | 'other'
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  r2Key: text("r2_key").notNull(), // R2 object key
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Indexes
// - runs: (idempotency_key) UNIQUE — deduplication
// - runs: (ci_build_id) — shard merging
// - runs: (branch, created_at) — branch filtering
// - runs: (repo, created_at) — repo filtering
// - testResults: (test_id, created_at) — per-test history
// - testResults: (run_id) — run detail view
// - testResults: (status, created_at) — flaky test queries
// - testTags: (tag) — filter by tag
// - testTags: (test_result_id) — join back to results
// - testAnnotations: (test_result_id) — join back to results
```

### Stable Test ID

The `testId` is a hash of `file + titlePath + projectName` — this is how we track the same test across runs. Playwright's `test.id` changes between runs, so we need our own stable identifier.

**Known limitations** (document prominently in user-facing docs):

- Renaming a `describe` block breaks every test ID inside it
- Fixing a typo in a test title creates a "new" test and orphans the old history
- Moving a test between files breaks tracking
- Changing the Playwright project name breaks tracking

This is the same approach used by Currents.dev and TestDino. The tradeoff is acceptable — these are infrequent operations, and the alternative (fuzzy matching) introduces its own class of bugs.

### Idempotency

The CLI generates an idempotency key per upload (e.g., `{ciBuildId}-{shardIndex}` or a UUID). The ingest endpoint checks the `idempotency_key` unique constraint:

- If the key doesn't exist: insert normally, return `201 Created`
- If the key already exists: return `200 OK` with the existing run ID, skip insertion
- This makes retries safe — a flaky network in CI won't create duplicate runs

## CLI Package (`@greenroom/cli`)

### Upload Flow

```bash
# After Playwright tests finish, upload results
npx @greenroom/cli upload ./playwright-report.json \
  --url https://your-dashboard.example.com \
  --token $GREENROOM_API_KEY
```

The CLI:

1. **Reads** the Playwright JSON report file
2. **Detects CI environment** — extracts branch, commit SHA, PR number, `ciBuildId`, shard info from environment variables (`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, etc.)
3. **Computes stable test IDs** — hashes `file + titlePath + projectName` for each test
4. **Generates idempotency key** — `{ciBuildId}-{shardIndex}` in CI, or a UUID for local runs
5. **POSTs to `/api/ingest`** — single request with run metadata + all test results
6. **Collects artifacts** — finds traces, screenshots, and videos referenced in the JSON report
7. **Uploads artifacts to `/api/artifacts`** — presigned URL flow: request upload URL from dashboard, PUT directly to R2
8. **Prints summary** — run URL, pass/fail counts, any upload errors

### Configuration

```bash
# Config file (~/.greenroomrc or .greenroomrc in project root)
{
  "url": "https://your-dashboard.example.com",
  "token": "grn_abc123..."
}

# Or environment variables
GREENROOM_URL=https://your-dashboard.example.com
GREENROOM_API_KEY=grn_abc123...

# Or CLI flags (override config/env)
npx @greenroom/cli upload ./report.json --url=... --token=...
```

### Artifact Upload Strategy

By default, the CLI uploads artifacts only for **failed and flaky tests** to conserve R2 storage. This matches Playwright's recommended `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` config.

```bash
# Override: upload all artifacts
npx @greenroom/cli upload ./report.json --artifacts=all

# Override: skip artifact upload entirely
npx @greenroom/cli upload ./report.json --artifacts=none
```

### Usage in playwright.config.ts

```typescript
export default defineConfig({
  reporter: [
    ["html"], // keep the built-in HTML reporter for local debugging
    ["json", { outputFile: "playwright-report.json" }], // Greenroom reads this
  ],
});
```

### Usage in CI (GitHub Actions)

```yaml
- name: Run Playwright tests
  run: npx playwright test

- name: Upload to Greenroom
  if: always() # upload even if tests failed
  run: npx @greenroom/cli upload ./playwright-report.json
  env:
    GREENROOM_URL: ${{ secrets.GREENROOM_URL }}
    GREENROOM_API_KEY: ${{ secrets.GREENROOM_API_KEY }}
```

## API Design

### `POST /api/ingest`

Receives test results from the CLI. Authenticated via Bearer token.

**Headers:**

- `Authorization: Bearer <api-key>`
- `X-Greenroom-Version: 1` — protocol version for compatibility negotiation
- `Content-Type: application/json`

**Request body:**

```json
{
  "idempotencyKey": "12345-0",
  "run": {
    "ciProvider": "github-actions",
    "ciBuildId": "12345",
    "branch": "main",
    "commitSha": "abc123",
    "commitMessage": "fix: payment flow",
    "prNumber": 42,
    "repo": "org/repo",
    "shardIndex": 0,
    "shardTotal": 4,
    "status": "failed",
    "durationMs": 120000,
    "reporterVersion": "0.1.0",
    "playwrightVersion": "1.50.0"
  },
  "results": [
    {
      "testId": "a1b2c3d4",
      "title": "Payment flow > should complete checkout",
      "file": "tests/payment.spec.ts",
      "projectName": "chromium",
      "status": "failed",
      "durationMs": 12300,
      "retryCount": 1,
      "errorMessage": "Expected element to be visible",
      "errorStack": "...",
      "workerIndex": 0,
      "tags": ["@smoke", "@payments"],
      "annotations": [{ "type": "issue", "description": "GH-123" }]
    }
  ]
}
```

**Responses:**

- `201 Created` — `{ "runId": "...", "runUrl": "...", "artifactUploadUrls": {...} }`
- `200 OK` — idempotent hit, returns existing run: `{ "runId": "...", "runUrl": "...", "duplicate": true }`
- `400 Bad Request` — validation error: `{ "error": "...", "details": [...] }`
- `401 Unauthorized` — invalid or revoked API key
- `409 Conflict` — protocol version mismatch: `{ "error": "...", "minimumVersion": 1, "maximumVersion": 2 }`

**Batch insertion strategy:** If the `results` array exceeds 1000 items, the endpoint splits into multiple D1 batch transactions within the same request handler. Tags and annotations are inserted in separate batch transactions after test results.

### `POST /api/artifacts/presign`

Returns presigned R2 upload URLs. The CLI then PUTs directly to R2.

**Request body:**

```json
{
  "runId": "...",
  "artifacts": [
    {
      "testResultId": "...",
      "type": "trace",
      "name": "trace.zip",
      "contentType": "application/zip",
      "sizeBytes": 1048576
    }
  ]
}
```

**Response:**

```json
{
  "uploads": [
    {
      "artifactId": "...",
      "uploadUrl": "https://r2.cloudflarestorage.com/...",
      "r2Key": "artifacts/run-id/test-result-id/trace.zip"
    }
  ]
}
```

### Version Negotiation

The `X-Greenroom-Version` header declares the protocol version the CLI speaks. The dashboard supports a range of versions:

- If the version is within range: process normally
- If the version is too old: return `409` with a clear error message telling the user to upgrade their CLI
- If the version is too new: return `409` telling the user to upgrade their dashboard

The protocol version increments when the request/response schema changes in a backwards-incompatible way. Additive changes (new optional fields) do not require a version bump.

## Dashboard Pages

### Core views (MVP)

1. **Runs list** (`/`)
   - Table: branch, commit, status (pass/fail), test counts, duration, timestamp
   - Filter by: branch, repo, status, date range
   - Shard-aware: group shards by `ciBuildId`, show merged totals

2. **Run detail** (`/runs/:id`)
   - Summary: pass/fail/flaky/skipped counts, total duration, commit info
   - Test list: sortable by status, duration, name; filterable by tag
   - Click through to test detail
   - If sharded: show per-shard breakdown alongside merged totals

3. **Test detail** (`/runs/:runId/tests/:testResultId`)
   - Error message + stack trace (syntax highlighted)
   - Artifacts: trace viewer link (via `trace.playwright.dev`), screenshots inline, video player
   - Retry history within this run
   - Tags and annotations
   - Link to historical view of this test

4. **Test history** (`/tests/:testId`)
   - Sparkline: pass/fail/flaky over last N runs
   - Duration trend chart
   - Flakiness percentage over configurable windows (7d, 30d, 90d)
   - List of recent results with links to run detail

5. **Flaky tests** (`/flaky`)
   - Ranked list of tests by flakiness rate
   - Filters: time window, branch (default: main/master), minimum run count, tags
   - Each row: test name, flakiness %, fail count, last seen, trend sparkline

6. **Insights** (`/insights`)
   - Suite duration trend over time
   - Top 10 slowest tests
   - Flaky test count trend
   - Pass rate trend
   - Tests with duration regression (>20% slower than rolling average)

### Nice-to-have views (post-MVP)

- **Branch comparison** — compare test results between two branches
- **PR view** — all runs associated with a PR, with status timeline
- **Settings** — retention policy, artifact storage limits, API key management
- **Notifications** — webhook on flaky test threshold breach

## GitHub Integration

### PR Comment (GitHub Action)

A lightweight GitHub Action that runs after the CLI uploads results:

```yaml
- uses: greenroom/github-action@v1
  with:
    api-url: ${{ secrets.GREENROOM_URL }}
    api-key: ${{ secrets.GREENROOM_API_KEY }}
```

Posts a comment like:

```
247 passed / 2 failed / 3 flaky / 5 skipped
4m 32s across 4 shards

| Test | Status | Duration |
|------|--------|----------|
| Payment flow > checkout | Failed | 12.3s |
| Payment flow > refund | Failed | 8.1s |
| Auth > login redirect | Flaky (retry 1) | 3.2s |

View full report: https://your-dashboard.example.com/runs/abc123
```

**Note:** Fork PRs cannot access repository secrets. The Action should degrade gracefully — skip the comment and log a warning rather than failing the workflow.

## Project Structure

```
greenroom/
├── packages/
│   ├── cli/                          # npm package: @greenroom/cli
│   │   ├── src/
│   │   │   ├── index.ts              # CLI entry point (upload command)
│   │   │   ├── parser.ts             # Reads Playwright JSON report → structured data
│   │   │   ├── api-client.ts         # HTTP client for dashboard API
│   │   │   ├── test-id.ts            # Stable test ID hashing
│   │   │   ├── ci-detect.ts          # Auto-detect CI provider + extract metadata
│   │   │   ├── artifact-collector.ts # Find and upload traces/screenshots/videos
│   │   │   └── types.ts              # Shared types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── dashboard/                    # RedwoodSDK app (Cloudflare Worker)
│   │   ├── src/
│   │   │   ├── worker.tsx            # Entry point: defineApp with routes
│   │   │   ├── db/
│   │   │   │   ├── schema.ts         # Drizzle schema (runs, testResults, artifacts, apiKeys, etc.)
│   │   │   │   └── migrations/       # Generated by drizzle-kit
│   │   │   ├── routes/
│   │   │   │   ├── api/
│   │   │   │   │   ├── ingest.ts     # POST /api/ingest — receive test results
│   │   │   │   │   ├── artifacts.ts  # POST /api/artifacts/presign — presigned R2 URLs
│   │   │   │   │   └── middleware.ts # Auth, version negotiation, rate limiting
│   │   │   │   ├── runs/
│   │   │   │   │   ├── page.tsx      # Runs list (RSC — queries D1 directly)
│   │   │   │   │   └── [id]/
│   │   │   │   │       └── page.tsx  # Run detail
│   │   │   │   ├── tests/
│   │   │   │   │   └── [testId]/
│   │   │   │   │       └── page.tsx  # Test history
│   │   │   │   ├── flaky/
│   │   │   │   │   └── page.tsx      # Flaky test dashboard
│   │   │   │   └── insights/
│   │   │   │       └── page.tsx      # Trends and analytics
│   │   │   ├── components/           # Shared React components
│   │   │   │   ├── charts/           # Duration trends, sparklines, pass rate
│   │   │   │   ├── tables/           # Test result tables, sortable/filterable
│   │   │   │   └── layout/           # Shell, nav, sidebar
│   │   │   └── lib/
│   │   │       ├── queries.ts        # Drizzle query helpers
│   │   │       ├── flaky.ts          # Flakiness calculation logic
│   │   │       └── auth.ts           # API key validation
│   │   ├── wrangler.jsonc            # D1 + R2 bindings
│   │   ├── drizzle.config.ts
│   │   └── package.json
│   │
│   └── github-action/                # GitHub Action for PR comments
│       ├── action.yml
│       ├── src/
│       │   └── index.ts
│       └── package.json
│
├── examples/
│   └── github-actions-workflow.yml   # Complete example CI workflow
│
├── package.json                      # Monorepo root (pnpm workspaces)
├── pnpm-workspace.yaml
├── LICENSE                           # MIT
└── README.md
```

## Implementation Phases

### Phase 1: Foundation (week 1–2)

**Goal:** CLI uploads test data to dashboard, dashboard stores it and shows a basic run list.

- [ ] Scaffold RedwoodSDK project with D1 + R2 bindings
- [ ] Define Drizzle schema (all tables: runs, testResults, testTags, testAnnotations, artifacts, apiKeys) and run initial migration
- [ ] Build API key management — create/revoke keys, hash storage, validation middleware
- [ ] Build `/api/ingest` endpoint — accepts batch test results, validates with Zod, chunks into D1 batch transactions (≤1000 per batch), inserts tags and annotations into separate tables
- [ ] Implement idempotency — check `idempotency_key` unique constraint, return existing run on duplicate
- [ ] Implement version negotiation — `X-Greenroom-Version` header check with clear error messages
- [ ] Build the CLI package — reads Playwright JSON report, computes stable test IDs, detects CI env, POSTs to dashboard
- [ ] Build runs list page — simple table, no filters yet
- [ ] Build run detail page — test list with status, duration, errors
- [ ] **Local development setup** — documented workflow: Miniflare for D1/R2, seed script with sample data, CLI pointed at `localhost`
- [ ] Test end-to-end: run Playwright tests locally → JSON report → CLI upload → see results in local dashboard

### Phase 2: Artifacts + Test History + Trace Viewer (week 3–4)

**Goal:** Traces and screenshots viewable in the dashboard. Tests trackable across runs. Trace viewer embedded.

- [ ] Build `/api/artifacts/presign` endpoint — returns presigned R2 upload URLs
- [ ] CLI artifact upload: request presigned URLs from dashboard, PUT directly to R2
- [ ] Artifact serving: presigned R2 URLs for downloads and inline display
- [ ] Test detail page — error display, inline screenshots, video player
- [ ] **Trace viewer integration** — embed Playwright's trace viewer (link to `trace.playwright.dev` with presigned R2 URL for the trace zip, or investigate self-hosted trace viewer component)
- [ ] Stable test ID implementation in CLI — hash of file + title path + project
- [ ] Test history page — pass/fail timeline, duration trend chart
- [ ] Add all indexes for historical and tag-based queries
- [ ] Tag and annotation display on test detail and run detail pages

### Phase 3: Flaky Detection + Insights (week 5–6)

**Goal:** The dashboard surfaces actionable intelligence about test health.

- [ ] Flakiness calculation: query test results on main branch, compute flaky % per test
- [ ] Flaky tests page — ranked by flakiness rate, filterable by time window and tags
- [ ] Insights page — suite duration trend, slowest tests, pass rate trend
- [ ] Duration regression detection — flag tests >20% slower than their 30-day rolling average
- [ ] Cron Trigger for data cleanup — delete runs + test results + tags/annotations older than configurable retention period
- [ ] R2 lifecycle rules for artifact expiry

### Phase 4: CI Integration + Shard Merging + Polish (week 7–8)

**Goal:** Seamless CI experience, shard merging in dashboard, ready for public launch.

- [ ] GitHub Action for PR comments — summary table with link to dashboard
- [ ] Handle fork PR limitations gracefully (no secrets access)
- [ ] Shard merging in dashboard — group runs by `ciBuildId`, show merged view with per-shard breakdown
- [ ] Branch, repo, and tag filtering on all pages
- [ ] Search across test names
- [ ] README with setup guide, screenshots, architecture diagram
- [ ] Example GitHub Actions workflow in `/examples`
- [ ] Publish CLI to npm (`@greenroom/cli`), action to GitHub Marketplace
- [ ] Write tests for version negotiation to ensure backwards compatibility with older CLI versions

### Phase 5: Community + Growth (ongoing)

- [ ] GitLab CI, CircleCI, Azure DevOps support in CI detection
- [ ] Dark mode
- [ ] Multi-project support (multiple repos reporting to one dashboard)
- [ ] Webhook notifications (Slack, Discord) on flaky threshold breach
- [ ] Export to CSV/JSON
- [ ] Self-hosted trace viewer component (if `trace.playwright.dev` linking proves limiting)
- [ ] Branch comparison view
- [ ] PR timeline view

## Key Design Decisions

### CLI + JSON report, not a custom Reporter

The Greenroom CLI reads Playwright's built-in JSON reporter output instead of implementing a custom `Reporter` class. This decouples from Playwright's internal API, is simpler to test and debug (the JSON file is inspectable), and works as a natural CI pipeline stage. The JSON output format is stable across Playwright versions.

### Batch ingestion, not streaming

The CLI collects all results from the JSON report and sends one POST per shard. This is simpler, avoids D1 write pressure, and maps naturally to CI pipeline stages. Tradeoff: no real-time progress during a run. This is acceptable — Playwright's terminal output already covers that.

### Per-shard upload, dashboard merges

Each CI shard uploads independently. The dashboard groups shards by `ciBuildId` and presents merged views. This avoids requiring users to set up a merge step in CI and works naturally with any CI system that exposes a build/run ID.

### Stable test IDs via hashing

Playwright's internal `test.id` is not stable across runs. We generate our own by hashing `filePath + titlePath + projectName`. This enables cross-run tracking but means renamed/moved tests appear as new tests. See "Known limitations" section above.

### Artifacts only for failures (default)

To keep R2 storage manageable, the default CLI config uploads traces/screenshots/videos only for failed and flaky tests. Users can override with `--artifacts=all`. This matches Playwright's recommended `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` config.

### Presigned R2 URLs for artifact serving

Artifacts are served via presigned R2 URLs rather than proxied through the Worker. This avoids Worker CPU time for serving large files and isn't subject to the Worker response size limit. Presigned URLs have a configurable TTL (default: 1 hour).

### RSC for dashboard pages

Every dashboard page is a React Server Component that queries D1 directly. No client-side data fetching, no loading spinners, no REST API to maintain. Client components only for interactive bits: charts, sortable tables, filter dropdowns.

### Multiple API keys from day one

Instead of a single shared secret, the dashboard supports multiple API keys with labels. Keys are stored as hashes in D1 and can be individually revoked. This avoids the painful migration from "one key" to "many keys" that would otherwise be needed when a key is leaked or a pipeline is decommissioned.

### Tags and annotations as first-class tables

Tags and annotations are stored in dedicated tables (not JSON strings) to enable efficient filtering and searching. This adds insertion complexity but is essential for the "filter by tag" feature on run detail and flaky test pages.

## Self-Hosting Story

The target experience for a new user:

```bash
# 1. Clone and deploy
npx degit greenroom/greenroom my-dashboard
cd my-dashboard
pnpm install

# 2. Create Cloudflare resources
npx wrangler d1 create greenroom
npx wrangler r2 bucket create greenroom

# 3. Update wrangler.jsonc with the D1 database ID

# 4. Run migrations
npx wrangler d1 migrations apply greenroom

# 5. Deploy
pnpm run deploy

# 6. Create your first API key (via dashboard UI or CLI)
npx wrangler d1 execute greenroom --command "INSERT INTO api_keys ..."
# (or a seed script / dashboard admin page)

# 7. Add to your project
npm install @greenroom/cli
```

**Cloudflare free tier supports:** 100K Worker requests/day, 5M D1 reads/day, 100K D1 writes/day, 10GB R2 storage. This covers most small-to-medium teams comfortably. Larger teams upgrade to the $5/month Workers Paid plan.

## Decisions (Resolved)

| Question                        | Decision        | Rationale                                                                                                                       |
| ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Support non-Playwright runners? | No              | Playwright-specific features (traces, annotations, projects) are core differentiators. Generalization would dilute the product. |
| SQLite alternative to D1?       | No              | Split maintenance focus kills OSS projects. Community contribution if demand exists.                                            |
| License                         | MIT             | Lower friction for adoption, matches Playwright itself.                                                                         |
| Monorepo tooling                | pnpm workspaces | Skip Turborepo unless pain is felt — overhead for 3 packages.                                                                   |
| Naming                          | Greenroom       | Unique, memorable, theater metaphor without being too literal. Good for npm scope and SEO.                                      |
