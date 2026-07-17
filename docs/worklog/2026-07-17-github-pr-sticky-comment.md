# Sticky GitHub PR comment (App-posted run summary)

## What changed

The dashboard now upserts a single **sticky PR comment** for every completed
run that carries a `repo` + `prNumber`, alongside the existing check run. Check
runs are easy to miss in the PR UI; the comment is the summary teams actually
read. It renders:

- the check-run-parity headline + passed/failed/flaky/skipped/duration table;
- failures split **new vs. known** — new = failing here but passing/absent on
  the branch's previous terminal run, known = already failing there;
- **flaky detections** for this run (passed only after retry);
- deep links: each listed test → its test-result page, plus "View run report"
  and (when a baseline exists) "Compare to base" (`…/runs/:id/diff`);
- capped at 10 lines per section with an "…and N more" overflow.

New module `apps/dashboard/src/lib/github-pr-comment.ts`
(`maybePostGithubPrComment(runId, projectId)`), called best-effort (never
throws) from the same three terminal ingest paths as `maybePostGithubCheck`:
`completeRun`, `completeShardedRun` (only when all shards are done), and
`finalizeStaleRun`.

## Why dashboard-side / design notes

- Same rationale as the check run (`github-checks.ts` module doc): installation
  tokens work on fork PRs, the dashboard owns the authoritative aggregates, and
  watchdog-finalized runs never reach reporter `onEnd`. The reporter's
  CI-token `postPrComment` stays as the no-App fallback; distinct markers, so
  running both stacks two comments — SELF-HOSTING now says pick one.
- **Sticky identity is per PR, not per run** — new table `githubPrComments`
  keyed unique `(projectId, repo, prNumber)` storing the GitHub comment id.
  The DB row (not a marker scan) locates the comment; the
  `<!-- wrightful:pr-summary:<projectId> -->` marker is for human debugging and
  project disambiguation.
- **Race safety** mirrors the check-run claim: `claimedAt` claim-before-POST
  CAS (120s TTL) so concurrent completions of the same run never stack
  duplicate comments; POST failure releases the claim; PATCH 404 (a human
  deleted the comment) reposts fresh.
- **Stale-run guard**: `githubPrComments.runId` records which run the comment
  renders; run ids are ULIDs (time-ordered), so a watchdog finalizing an old
  push late declines instead of regressing the comment to stale content.
- **Baseline choice**: NOT `resolveBaseRun` (the diff page's last-_passed_
  anchor) — a passed baseline contains no failing rows, so "known failures"
  could never be non-empty. The comment resolves the most recent **terminal**
  run on the same branch (`resolveCommentBaseRun`) and feeds the existing pure
  `diffRuns` via `computeRunDiff`. Failing `addedTests` count as new failures.
  First run on a PR branch has no baseline → a single un-split "Failures"
  section. Possible future upgrade: diff against the PR's _target_ branch
  (needs the target branch, which ingest doesn't capture today).
- Tenancy: same confused-deputy boundary as checks — the installation lookup is
  scoped to the run's own `teamId`, never resolved from the attacker-controlled
  `repo` owner alone. The `TenantScope` for the diff queries is built from the
  trusted joined run row (same rationale as `finalizeStaleRun`).
- The GitHub App now needs **Pull requests: Read & write** (comments go through
  the issues API with an installation token). Without it the POST 403s — logged
  via `logger.error`, ingest unaffected.

## Migration

`20260717214015_nosy_daimon_hellstrom.sql` — creates `githubPrComments` with
FKs (`projectId` cascade, `runId` set-null) and the unique
`(projectId, repo, prNumber)` index.

## Files

- `apps/dashboard/src/lib/github-pr-comment.ts` — new (render + claim + post).
- `apps/dashboard/db/schema.ts` — `githubPrComments` table.
- `apps/dashboard/src/lib/github-checks.ts` — exported `formatDuration`.
- `apps/dashboard/src/lib/ingest.ts` — three call sites.
- `apps/dashboard/src/__tests__/github-pr-comment.workers.test.ts` — pure
  rendering/bucketing/path tests.
- `apps/dashboard/src/__tests__/github-pr-comment-claim.test.ts` — pglite
  integration: first-POST persist, PATCH + new-vs-known content end-to-end,
  claim race (exactly one POST), claim release on failure, stale-run guard,
  PATCH-404 repost, tenancy no-ops.
- `SELF-HOSTING.md`, `docs/ARCHITECTURE.md` — App permission + table docs.

## Verification

- `pnpm --filter @wrightful/dashboard test` — both lanes green (includes the
  20 new tests).
- `pnpm check` and `pnpm --filter @wrightful/dashboard typecheck` — clean.
