# 2026-04-18 — Capture CI actor + populate commit message via git

## What changed

Two pieces of run context are now captured from CI and surfaced on the dashboard:

1. **actor** — who triggered the CI run. Read from provider env vars: `GITHUB_TRIGGERING_ACTOR` (falling back to `GITHUB_ACTOR`) on GHA, `GITLAB_USER_LOGIN` on GitLab, `CIRCLE_USERNAME` on CircleCI. New `runs.actor` column.
2. **commit message** — previously hardcoded to `null` for GHA/CircleCI; now populated by shelling out to `git log -1 --pretty=%B` from inside the CLI. No user workflow changes required. On GHA PR events this will return the synthetic merge-commit message ("Merge abc into def") — acceptable trade-off vs. asking users to pass `GITHUB_TOKEN` or tweak `fetch-depth`. GitLab still prefers `CI_COMMIT_MESSAGE` and only falls back to git.

## Details

| Area             | Files                                                                | Change                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI types        | `packages/cli/src/types.ts`                                          | Added `actor: string \| null` to `CIInfo` and `RunPayload`.                                                                                  |
| CLI detect       | `packages/cli/src/lib/ci-detect.ts`                                  | Added `readGitCommitMessage()` helper using `execFileSync`; populated `actor` + `commitMessage` for all provider branches.                   |
| CLI payload      | `packages/cli/src/commands/upload.ts`                                | Pass `actor` into the ingest payload.                                                                                                        |
| CLI parser       | `packages/cli/src/lib/parser.ts`                                     | Added `actor` to the `Omit<RunPayload, ...>` in `ParsedReport`.                                                                              |
| CLI tests        | `packages/cli/src/__tests__/ci-detect.test.ts`, `api-client.test.ts` | Mocked `child_process.execFileSync`; asserted actor per-provider; added `readGitCommitMessage` edge-case tests.                              |
| Dashboard zod    | `packages/dashboard/src/routes/api/schemas.ts`                       | Added optional `actor` field to `RunMetadataSchema`.                                                                                         |
| Dashboard DB     | `packages/dashboard/src/db/schema.ts`                                | Added nullable `actor` TEXT column to `runs`.                                                                                                |
| Dashboard ingest | `packages/dashboard/src/routes/api/ingest.ts`                        | Insert `actor` on run create.                                                                                                                |
| Dashboard UI     | `packages/dashboard/src/app/pages/runs-list.tsx`, `run-detail.tsx`   | Show `@actor` next to commit message in the list; in run detail show it as a badge in the header and a "Triggered by" row in the Build card. |
| Tests (dash)     | `packages/dashboard/src/__tests__/schemas.test.ts`                   | Added `actor` to the valid payload fixture.                                                                                                  |

## Migrations

Per the pre-launch squashing convention, the two existing migrations (`0000_odd_gamma_corps.sql`, `0001_whole_madame_web.sql`) and `drizzle/meta/` were deleted and regenerated into a single `0000_dazzling_serpent_society.sql` via `pnpm --filter @wrightful/dashboard db:generate`. Applied locally via `db:migrate:local`.

## Verification

- `pnpm --filter @wrightful/cli test` — 86/86 pass.
- `pnpm --filter @wrightful/dashboard test` — 55/55 pass.
- `pnpm typecheck` — clean (both packages).
- `pnpm lint` — 0 errors, 2 pre-existing warnings unrelated to this change.
- `pnpm --filter @wrightful/dashboard db:migrate:local` — fresh schema applied successfully (36 commands).

## Out of scope (intentionally deferred)

- GitHub App / webhook ingestion (Vercel-style).
- `GITHUB_TOKEN`-backed API enrichment (real PR head commit message, actor avatar URLs).
- Filtering / sorting runs by actor in the list UI.
