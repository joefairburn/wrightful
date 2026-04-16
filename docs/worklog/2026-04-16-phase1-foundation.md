# 2026-04-16 — Phase 1 Foundation Scaffolding

## What we built

Scaffolded the entire Greenroom monorepo from a blank repo (just `.gitignore` and `docs/PRD.md`) into a working product with CLI, dashboard, and full test coverage.

### Monorepo structure

- pnpm workspaces with 4 packages: `dashboard`, `cli`, `github-action`, `e2e`
- MIT license, no Turborepo (PRD defers that)

### Dashboard (`packages/dashboard/`)

**Stack:** RedwoodSDK 1.1.0, Vite 7.3, Cloudflare D1 + R2, Drizzle ORM

- **Drizzle schema** — 6 tables matching the PRD: `apiKeys`, `runs`, `testResults`, `testTags`, `testAnnotations`, `artifacts`. 12 indexes. Migration generated and tested.
- **API key auth** — SHA-256 hashing, prefix-based lookup, revocation support, lastUsedAt tracking
- **Middleware** — `requireAuth` (401 on bad/missing key) and `negotiateVersion` (409 on version mismatch, currently supports version 1)
- **Zod validation** — Full schemas for `/api/ingest` and `/api/artifacts/presign` request bodies
- **POST /api/ingest** — Batch insert with idempotency (unique constraint on `idempotency_key`), D1 chunking (900 per batch to stay under 1000 statement limit), separate batch inserts for tags and annotations
- **POST /api/artifacts/presign** — Phase 1 stub: creates artifact records in D1, returns placeholder R2 URLs. Error handling for FK constraint violations.
- **Runs list page** (`/`) — RSC querying D1 directly, table with status badges, branch, commit, pass/fail/flaky/skip counts, duration, relative time
- **Run detail page** (`/runs/:id`) — Summary header with counts + test results table sorted by status (failed first), error messages displayed for failures
- **Routing** — API routes under `prefix("/api", [...])` with auth middleware, RSC pages under `render(Document, [...])`

### CLI (`packages/cli/`)

**Stack:** TypeScript, tsup (ESM, 13.5KB bundle), commander, cosmiconfig, zod

- **Parser** — Recursive Playwright suite tree walker. Handles nested describes, maps `expected`/`unexpected`/`flaky`/`skipped` to Greenroom statuses, extracts errors from the correct retry for flaky tests, sums durations across retries, rounds fractional milliseconds to integers.
- **Stable test IDs** — SHA-256 of `file + titlePath + projectName` with null-byte separators, truncated to 16 hex chars
- **CI detection** — GitHub Actions, GitLab CI, CircleCI, generic CI. Extracts build ID, branch, commit SHA, PR number, repo from provider-specific env vars.
- **Idempotency** — `{ciBuildId}-{shardIndex}` in CI (retry-safe), random UUID for local runs
- **Config resolution** — CLI flags > `GREENROOM_URL`/`GREENROOM_API_KEY` env vars > cosmiconfig rc file
- **API client** — Native fetch with retry (exponential backoff on 500/429, no retry on 400/401/409)
- **`--dry-run` mode** — Parse report and print payload as JSON without uploading
- **Artifact collector** — Phase 1 no-op stub

### GitHub Action (`packages/github-action/`)

Placeholder with `action.yml` inputs defined. Implementation deferred to Phase 4.

### Tests

**88 unit tests + 18 e2e tests = 106 total**

| Suite                  | Count | Covers                                                                                                                                   |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/test-id`          | 8     | Determinism, collision avoidance, null-byte separators                                                                                   |
| `cli/ci-detect`        | 9     | GitHub Actions, GitLab CI, CircleCI, generic, local                                                                                      |
| `cli/idempotency`      | 6     | CI key format, shard defaults, UUID fallback                                                                                             |
| `cli/parser`           | 17    | Status mapping, error extraction, flaky handling, title paths, tags, annotations, shard info, invalid input                              |
| `cli/api-client`       | 8     | Auth headers, success/duplicate, 401/409, retry on 500/429, no retry on 400                                                              |
| `cli/config`           | 7     | Precedence, defaults, validation                                                                                                         |
| `cli/logger`           | 7     | All output functions, formatting                                                                                                         |
| `dashboard/schemas`    | 18    | All Zod schemas, enums, defaults, nullable fields, boundaries                                                                            |
| `dashboard/middleware` | 8     | Auth 401/passthrough, version negotiation 400/409                                                                                        |
| `e2e`                  | 18    | Full pipeline: real Playwright report generation, CLI upload, auth, validation, versioning, SSR rendering, run detail, artifacts presign |

### E2E flow (`packages/e2e/`)

`pnpm test:e2e` runs the full product flow locally:

1. Builds CLI
2. Applies D1 migrations + seeds API key
3. Starts dashboard dev server (Vite + Miniflare)
4. Runs real Playwright tests against playwright.dev → generates genuine JSON report
5. Uploads report through CLI → verifies 201 response
6. Checks dashboard SSR renders the run data
7. Checks run detail page shows test results
8. Tests auth rejection, validation errors, version negotiation
9. Tests artifacts presign endpoint

### CI

- `.github/workflows/ci.yml` — 4 jobs: lint/typecheck, CLI tests, dashboard tests, e2e
- `pnpm ci:local` — runs the workflow locally via `@redwoodjs/agent-ci` (requires Docker)

## Bugs fixed during development

1. **`worker-configuration.d.ts` conflict** — wrangler refuses to overwrite a manually created file. Fix: don't create it, let `rw-scripts dev-init` generate it.
2. **Route method casing** — RWSDK uses lowercase method keys (`post`, not `POST`). Caused 405 Method Not Allowed on API routes.
3. **Style prop as string** — `StatusBadge` passed CSS strings to React's `style` prop instead of objects. Caused SSR crash when rendering runs with data.
4. **Fractional durationMs** — Playwright's `stats.duration` is a float (e.g. `2125.534`). Zod schema requires integer. Fix: `Math.round()` in the CLI parser.

## Commands

```bash
pnpm dev          # Start dashboard on localhost:5173
pnpm test         # Run 88 unit tests (CLI + dashboard)
pnpm test:e2e     # Run 18 e2e tests (full product flow)
pnpm ci:local     # Run GitHub Actions workflow locally
pnpm --filter @greenroom/cli build   # Build CLI to dist/
```
