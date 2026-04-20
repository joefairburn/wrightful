# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Wrightful

Wrightful is a Playwright test reporting dashboard. A custom Playwright reporter streams test results live to a Cloudflare Workers-based dashboard that stores data in D1 (SQLite) and artifacts in R2.

## Monorepo Structure

pnpm workspace with three packages:

- **`packages/reporter`** — Playwright reporter (`@wrightful/reporter`). Streams results + artifacts to the dashboard as each test completes. Built with tsdown (rolldown). Per-test emission: one row per test at its final outcome, with retries aggregated into `flaky`.
- **`packages/dashboard`** — Cloudflare Worker app using [RedwoodSDK (rwsdk)](https://docs.rwsdk.com). Vite + React 19 RSC. Drizzle ORM on D1, R2 for artifacts. Styled with Tailwind v4 + Base UI primitives wrapped as a local component library in `src/app/components/ui/`; nuqs for URL state. Dashboard auth is Better Auth (sessions, email + password, optional GitHub OAuth); API auth is Bearer API keys. Dashboard serves the streaming ingest + artifact API (`/api/runs/*`, `/api/artifacts/*`) and the tenant-scoped UI (`/t/:teamSlug/p/:projectSlug/…`).
- **`packages/e2e`** — Playwright E2E tests that run against the Playwright docs site (demo suite used to generate test reports for dogfooding). Uses the reporter when `WRIGHTFUL_URL` / `WRIGHTFUL_TOKEN` env is set.

## Commands

```bash
# Install
pnpm install

# Dev server (dashboard)
pnpm dev

# Build
pnpm build                                   # dashboard (vite build) + reporter (tsdown)
pnpm --filter @wrightful/reporter build      # reporter only

# Tests
pnpm test                                    # dashboard + reporter unit tests (vitest)
pnpm --filter @wrightful/dashboard test      # dashboard tests only
pnpm --filter @wrightful/reporter test       # reporter tests only
pnpm test:e2e                                # e2e (playwright)

# Single test file
pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/schemas.test.ts
pnpm --filter @wrightful/reporter exec vitest run src/__tests__/aggregation.test.ts

# Lint & format (oxc toolchain — not eslint/prettier)
pnpm lint                               # oxlint (check)
pnpm lint:fix                           # oxlint --fix
pnpm format                             # oxfmt --check
pnpm format:fix                         # oxfmt --write

# Typecheck (uses tsgo — native TypeScript compiler preview)
pnpm typecheck                          # dashboard + reporter

# Database migrations (dashboard)
pnpm --filter @wrightful/dashboard db:generate       # generate migration from schema
pnpm --filter @wrightful/dashboard db:migrate:local  # apply to local D1
pnpm --filter @wrightful/dashboard db:migrate:remote # apply to remote D1
```

## Key Architecture Details

**Dashboard routing** (`packages/dashboard/src/worker.tsx`): rwsdk's `defineApp` composes middleware chains. API routes are under `prefix("/api", [...])` with `requireAuth` + `negotiateVersion` middleware, while dashboard pages use `render(Document, [...])` for RSC rendering.

**Streaming ingest flow**: `@wrightful/reporter` loads in the user's `playwright.config.ts`. At `onBegin` it opens a run via `POST /api/runs`; per-test `onTestEnd` events buffer until the test is done (all retries finished) and then flush in batches via `POST /api/runs/:id/results`. Each response returns `clientKey → testResultId`, which the reporter uses to register + PUT artifacts via `POST /api/artifacts/register` + presigned R2 URLs. `onEnd` calls `POST /api/runs/:id/complete` to set the terminal status.

**Shared schema contract**: Wire types live in both `packages/reporter/src/types.ts` (TypeScript interfaces) and `packages/dashboard/src/routes/api/schemas.ts` (Zod). Keep them in sync when changing the API contract.

**Auth**: API key auth via `Authorization: Bearer <key>`. Keys are SHA-256 hashed, looked up by 8-char prefix, then hash-compared. Defined in `packages/dashboard/src/lib/auth.ts`.

**Protocol versioning**: `X-Wrightful-Version` header. Currently only version 3 is supported — older reporters/CLIs get a 409.

## Frontend Stack & UI Conventions

The dashboard uses Tailwind v4 + Base UI, wrapped as a local component library. Prefer reuse over hand-rolled markup.

- **Check `packages/dashboard/src/app/components/ui/` first.** ~50 components already exist (`button`, `dialog`, `table`, `input`, `select`, `tabs`, `tooltip`, `toast`, etc.) — each is a thin wrapper over a Base UI primitive, styled with Tailwind + `class-variance-authority`. Use an existing wrapper if one fits; extend one if it's close; only hand-roll if nothing matches. Do **not** import `@base-ui-components/react` directly from page code — go through the `ui/` wrappers.
- **Tailwind v4** — no `tailwind.config.*`. Theme tokens (colors, fonts, radii, animations, dark-mode scope) live in `packages/dashboard/src/app/styles.css` under `@theme { … }`. Extend tokens there; don't inline theme values.
- **`cn()` helper** — `packages/dashboard/src/lib/cn.ts` (`twMerge(clsx(...))`). Use it for every merged/conditional `className`. The existing `ui/` components all use it.
- **COSS registry** — `packages/dashboard/components.json` is wired to `https://coss.com/ui/r/{name}.json`. Scaffold new components with `npx shadcn@latest add @coss/<name>` (drops into `src/app/components/ui/`). Prefer this over adding ad-hoc dependencies.
- **nuqs** — `NuqsAdapter` is mounted globally via `packages/dashboard/src/app/providers.tsx`. Use `useQueryState()` in client islands for filter/sort/pagination state instead of local `useState`.
- **Client islands** — default to RSC; add `"use client"` only when interactivity, nuqs, or Base UI client hooks require it. All `ui/` components are already client-boundary.

## Auth & Multi-Tenancy

Two auth systems coexist:

- **API auth** (`/api/*`) — Bearer API keys, scoped to a project. `packages/dashboard/src/lib/auth.ts`.
- **Dashboard auth** — Better Auth sessions (email + password, optional GitHub OAuth). Factory: `packages/dashboard/src/lib/better-auth.ts`. Mount: `/api/auth/*` via `packages/dashboard/src/routes/auth.ts`. Session middleware: `loadSession` + `requireUser` in `packages/dashboard/src/routes/middleware.ts`.

**Tenancy model:** `teams` → `projects` → `runs` (+ derived rows). Users join teams via `memberships` (`owner` | `member`).

**Routes:** dashboard pages live under `/t/:teamSlug/p/:projectSlug/…`; admin pages under `/admin/…`. `/` is a team picker.

**Authorization helpers — always use these instead of raw `teamId` / `projectId` lookups:**

- `getTeamRole(userId, teamSlug)` — `packages/dashboard/src/lib/authz.ts`
- `resolveTeamBySlug(slug, userId)` — same file
- `resolveProjectBySlugs(teamSlug, projectSlug, userId)` — same file
- `getActiveProject()` — `packages/dashboard/src/lib/active-project.ts` — reads route params, verifies membership, returns the active project. Use this at the top of any scoped route handler.

**Query scoping rule:** every read that touches `runs` (or derived tables: `testResults`, `testTags`, `testAnnotations`, `artifacts`) **must** filter by `projectId`. There is no implicit tenant filter — miss it and data leaks across tenants.

**Required env vars:** `BETTER_AUTH_SECRET`, `WRIGHTFUL_PUBLIC_URL`. Optional: `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`, `SIGNUP_GITHUB_ORGS` + `SIGNUP_EMAIL_DOMAINS` (instance-level signup whitelist — comma-separated; when either is set, email/password signup is blocked and new GitHub users are validated against `/user/orgs` + verified email domain).

## Worklogs

**Required.** When making significant changes or adding features, you must write a worklog entry in `docs/worklog/`. This is how we track what changed, why, and what was verified — future agents and contributors rely on these to understand project history beyond what git log shows.

**File naming:** `YYYY-MM-DD-short-description.md` (e.g. `2026-04-16-phase1-foundation.md`)

**Structure:** Each entry should include:

- **Title** — date + summary of what changed
- **What changed** — narrative description of the work
- **Details** — new dependencies, config changes, schema changes, scripts added, etc. (tables work well)
- **Code fixes / migrations** — specific files changed and why, if non-obvious
- **Verification** — what checks were run and their results (tests, lint, typecheck, manual testing)

See existing entries in `docs/worklog/` for the expected level of detail. Err on the side of being thorough — these are the project's source of truth for decision context.

Recent architectural worklogs worth reading before substantive work: `2026-04-17-frontend-stack-tailwind-baseui-nuqs.md` (frontend stack) and `2026-04-17-multi-tenancy.md` (teams/projects + Better Auth).

## Tooling Notes

- **Linting**: oxlint with type-aware rules enabled (not eslint). Config: `.oxlintrc.json`. Key rules: `no-floating-promises`, `no-misused-promises`, `await-thenable` are errors. React plugin is activated only for dashboard `.tsx` files.
- **Formatting**: oxfmt (not prettier). Config: `.oxfmtrc.json`. Double quotes, semicolons, trailing commas.
- **TypeScript**: `tsgo` (native TS compiler preview) for typechecking. Standard `tsc`/`typescript` is also installed.
- **Pre-commit hook**: Husky runs `lint-staged` which applies `oxlint --fix` + `oxfmt --write` to staged JS/TS files.
- **IDs**: ULIDs for all database primary keys (via `ulid` package).
