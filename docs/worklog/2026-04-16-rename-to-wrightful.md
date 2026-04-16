# 2026-04-16 — Rename project: Greenroom → Wrightful

## What changed

Global rebrand from "Greenroom" to "Wrightful". Since the project is pre-launch
(nothing published, no live infrastructure), every identifier — npm scope, CLI
binary, wrangler resources, env vars, protocol header, config namespace, docs
— was renamed in one sweep. The new domain is `wrightful.dev`.

Casing convention applied consistently:

| From          | To            | Use                                      |
| ------------- | ------------- | ---------------------------------------- |
| `greenroom`   | `wrightful`   | package names, CLI bin, wrangler, config |
| `Greenroom`   | `Wrightful`   | prose, titles, display strings           |
| `GREENROOM_*` | `WRIGHTFUL_*` | env var names                            |

## Details

### Package identity

| File                                  | Change                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                        | `name: greenroom` → `wrightful`; filters in scripts                                                                         |
| `packages/cli/package.json`           | `@greenroom/cli` → `@wrightful/cli`; `bin.greenroom` → `bin.wrightful`                                                      |
| `packages/dashboard/package.json`     | `@greenroom/dashboard` → `@wrightful/dashboard`; `db:migrate:*` scripts updated to `wrangler d1 migrations apply wrightful` |
| `packages/github-action/package.json` | `@greenroom/github-action` → `@wrightful/github-action`                                                                     |
| `packages/e2e/package.json`           | `@greenroom/e2e` → `@wrightful/e2e`                                                                                         |

### CLI

- `packages/cli/src/index.ts` — Commander `.name("greenroom")` → `.name("wrightful")`; description updated
- `packages/cli/src/commands/upload.ts` — description updated
- `packages/cli/src/lib/config.ts` — `cosmiconfig("greenroom")` → `cosmiconfig("wrightful")` (picks up `.wrightfulrc` etc.); `GREENROOM_URL` / `GREENROOM_API_KEY` / `GREENROOM_ARTIFACTS` env lookups renamed to `WRIGHTFUL_*`
- `packages/cli/src/lib/api-client.ts` — request header `X-Greenroom-Version` → `X-Wrightful-Version`
- `packages/cli/src/lib/logger.ts` — CLI banner "Greenroom v..." → "Wrightful v..."
- `packages/cli/src/types.ts` — `GreenroomConfig` interface → `WrightfulConfig`; header comment updated

### Dashboard (Cloudflare Worker)

- `packages/dashboard/wrangler.jsonc` — worker `name`, D1 `database_name`, R2 `bucket_name`, `R2_BUCKET_NAME` var, and all three `GREENROOM_*` vars renamed
- `packages/dashboard/worker-configuration.d.ts` — regenerated via `wrangler types` after wrangler.jsonc changes
- `packages/dashboard/types/env.d.ts` — `Cloudflare.Env` augmentation for the renamed `WRIGHTFUL_*` vars
- `packages/dashboard/src/routes/api/middleware.ts` — `X-Greenroom-Version` header (both occurrences) and user-facing error messages ("Please upgrade @greenroom/cli" / "Please upgrade your Greenroom dashboard") renamed
- `packages/dashboard/src/routes/api/artifacts.ts` + `artifact-download.ts` — env reads updated to `WRIGHTFUL_*`
- `packages/dashboard/src/app/document.tsx` — `<title>` updated
- `packages/dashboard/src/app/pages/runs-list.tsx` — inline code sample updated
- `packages/dashboard/src/app/pages/test-detail.tsx` — comment updated

### GitHub Action

- `packages/github-action/action.yml` — name + input descriptions renamed
- `packages/github-action/src/index.ts` — stub log messages + repo slug updated to `wrightful/wrightful`

### Tests

| File                                                         | Change                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `packages/cli/src/__tests__/parser.test.ts`                  | `/tmp/greenroom-*.json` → `/tmp/wrightful-*.json`                         |
| `packages/cli/src/__tests__/playwright-compat.test.ts`       | same                                                                      |
| `packages/cli/src/__tests__/artifact-collector.test.ts`      | temp-dir prefix `greenroom-artifacts-test-` → `wrightful-artifacts-test-` |
| `packages/cli/src/__tests__/logger.test.ts`                  | banner assertion                                                          |
| `packages/cli/src/__tests__/api-client.test.ts`              | request header assertion                                                  |
| `packages/cli/src/__tests__/config.test.ts`                  | env-var stubs                                                             |
| `packages/dashboard/src/__tests__/middleware.test.ts`        | header assertions                                                         |
| `packages/dashboard/src/__tests__/artifacts.test.ts`         | mock env + bucket name                                                    |
| `packages/dashboard/src/__tests__/artifact-download.test.ts` | mock env + bucket name                                                    |
| `packages/e2e/vitest.globalSetup.ts`                         | `R2_BUCKET_NAME`, D1 name in wrangler commands                            |
| `packages/e2e/src/e2e.test.ts`                               | `X-Greenroom-Version` headers, D1 query command                           |

### CI + docs

- `.github/workflows/ci.yml` — all `pnpm --filter @greenroom/*` → `@wrightful/*`
- `CLAUDE.md` — section heading, commands, protocol header
- `docs/PRD.md` — title, all `@greenroom/*`, `.greenroomrc`, GitHub Action slug, setup wrangler commands, degit path. The "Decisions — Naming" row updated to document the rebrand with pointer to this worklog.
- `docs/worklog/*.md` — existing entries updated in-place for `@greenroom/*`, env-var, bucket, D1 references (narrative untouched)
- `examples/github-actions-workflow.yml` — step name, package reference, env vars
- `LICENSE` — copyright line
- `.gitignore` — comment referencing the generate script

## Out of scope

- **Cloudflare remote resources.** No live D1 database or R2 bucket existed
  under the greenroom names, so nothing to migrate. First deploy requires
  creating `wrightful` D1 and `wrightful-artifacts` R2 in the Cloudflare
  account (the setup steps in `docs/PRD.md` already reflect the new names).
- **Local `.wrangler/state/**`** — cached dev data carries the old D1 name;
will regenerate on next `pnpm dev`.
- **Conductor workspace directory** `.../workspaces/greenroom/` — outside the
  git tree; user's to rename if desired.

## Verification

| Check                                                         | Result                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm install`                                                | lockfile up-to-date, no conflicts               |
| `pnpm lint`                                                   | 0 errors (5 pre-existing warnings)              |
| `pnpm exec oxfmt --check <tracked paths>`                     | clean                                           |
| `pnpm typecheck`                                              | clean (tsgo, cli + dashboard)                   |
| `pnpm test`                                                   | 83 CLI + 43 dashboard = 126 passing             |
| `pnpm --filter @wrightful/cli build`                          | tsup build success                              |
| `pnpm --filter @wrightful/dashboard build`                    | vite client + worker build success              |
| `pnpm --filter @wrightful/dashboard exec wrangler types`      | regenerated `worker-configuration.d.ts` cleanly |
| `rg -i greenroom` (excluding node_modules/.wrangler/.context) | single hit: the PRD rebrand note (intentional)  |

E2E (`pnpm test:e2e`) was not run — the E2E suite requires a local wrangler
dev server with migrations applied against the `wrightful` D1 instance, which
hasn't been bootstrapped in this workspace. The e2e setup scripts were
updated in-place, so the suite is expected to pass once the local D1 is
created under the new name.
