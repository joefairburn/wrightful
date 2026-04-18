# 2026-04-18 — Environments on runs + branch/PR surfacing

## What changed

Added a first-class `environment` field to runs and made the already-captured branch/PR metadata more visible in the dashboard UI.

The CLI accepts a new `--environment <name>` flag on `wrightful upload`; its value rides through the ingest payload into a new `runs.environment` column. Environments are free-form strings — no per-project configuration, no validation — mirroring how `branch` has always worked. A structured `environments` table can come later if we want validation or a settings page.

Branch/PR tracking was already ~80% in place: `detectCI()` has been populating `branch` and `prNumber` on every CI-driven upload (GitHub Actions, GitLab CI, CircleCI) since the initial schema. This change exposes that data properly:

- Runs-list table now has an **Env** column and a **PR** chip next to the branch pill (GitHub/GitLab PRs link out to the provider; other providers render an un-linked chip).
- Run-detail header shows an environment badge next to the branch/commit/PR chips.
- The sidebar card previously titled "Environment" — which actually lists Playwright / Reporter / CI / Build / PR — was renamed to **Build** and now also surfaces the real `environment` value as the first row. The PR row is linkified via the same helper.

Protocol version stays at **2**. The new field is a nullable optional on both ends of the wire, so existing CLI binaries keep uploading successfully, and new CLIs talking to a pre-migration dashboard degrade to a silent Zod ignore.

## Details

### Schema

New column + index (one generated migration, `drizzle/0001_whole_madame_web.sql`):

```sql
ALTER TABLE `runs` ADD `environment` text;
CREATE INDEX `runs_environment_created_at_idx` ON `runs` (`environment`,`created_at`);
```

The composite `(environment, created_at)` index mirrors `runs_branch_created_at_idx` so env-scoped history queries stay cheap.

### Wire contract

Kept in lockstep on both sides per `CLAUDE.md`:

| Where                                                                | Change                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/types.ts` — `RunPayload`                           | Added `environment: string \| null`                                                                           |
| `packages/dashboard/src/routes/api/schemas.ts` — `RunMetadataSchema` | Added `environment: z.string().nullable().optional()`                                                         |
| `packages/cli/src/lib/parser.ts` — `ParsedReport["run"]`             | Added `"environment"` to the `Omit<RunPayload, …>` list (CLI sources the value from the flag, not the report) |

### CLI

- `packages/cli/src/commands/upload.ts`: new `.option("--environment <name>", …)` on `uploadCommand`; the resolved value is written as `environment: options.environment ?? null` into the payload's `run` block. Flag only — no `WRIGHTFUL_ENVIRONMENT` env-var fallback (deliberately explicit). `detectCI()` is unchanged.

### Ingest handler

- `packages/dashboard/src/routes/api/ingest.ts`: persists `environment: payload.run.environment ?? null` in the `runs` insert alongside the other CI metadata.

### UI

- `packages/dashboard/src/lib/pr-url.ts` (new) — `prUrl(ciProvider, repo, prNumber)` returns a GitHub/GitLab PR/MR URL, or `null` if the provider isn't covered (CircleCI et al render a non-linked chip).
- `packages/dashboard/src/app/pages/runs-list.tsx` — new Env table column; Branch cell now also renders a `GitPullRequest`-iconed PR chip (linkified when possible). `db.select().from(runs)` already returns `environment` via `select()`, no explicit projection change.
- `packages/dashboard/src/app/pages/run-detail.tsx` — summary-card header gains environment badge + PR chip; the misleadingly-named "Environment" sidebar card was renamed to **"Build"** and the real `environment` value is now the first row. PR row linkifies via `prUrl`.

### Tests

- `packages/dashboard/src/__tests__/schemas.test.ts` — valid-payload fixture now includes `environment: "staging"`; added cases covering omitted and `null` environment.
- `packages/cli/src/__tests__/api-client.test.ts` — fixture updated with `environment: null` to satisfy `RunPayload`. No new test was added for the flag: there's no existing `upload.ts` command-integration test and the Zod schema tests cover the wire contract.

## Deliberate non-goals

- No `environments` table — environments remain implicit (whatever strings have been sent).
- No `WRIGHTFUL_ENVIRONMENT` env-var fallback in the CLI.
- No `--branch` / `--pr` / `--commit-sha` override flags in the CLI (CI detection is still the only source).
- No branch/environment filter UI on the runs list — easy follow-up with nuqs.
- No protocol version bump.

## Verification

- `pnpm typecheck` — passes for both packages (had to add `"environment"` to the `Omit` in `parser.ts` and fix the `api-client.test.ts` fixture; after that, clean).
- `pnpm lint` — 0 errors, 31 pre-existing warnings (none introduced by this change).
- `pnpm test` — 80/80 CLI + 55/55 dashboard unit tests pass (includes the two new environment cases).
- `pnpm format` — passes after running `pnpm format:fix` once to pick up the regenerated Drizzle metadata.
- `pnpm --filter @wrightful/dashboard db:generate` — produced `drizzle/0001_whole_madame_web.sql` as expected (add-column + create-index only). `db:migrate:local` / `:remote` not run here — deferred to the deploying engineer.
- Manual UI check: pending end-to-end exercise against `pnpm dev` with a real report upload; schema + type guarantees and protocol back-compat covered by the automated checks.

## Follow-ups

- Add a `/t/:teamSlug/p/:projectSlug?env=staging` nuqs-backed filter (and matching branch filter).
- Support more CI providers in `prUrl` (Bitbucket, self-hosted GitLab instances) or pass the provider base URL through the CLI.
- If users end up typo-ing environment names, consider a project-level `environments` table + validation.
