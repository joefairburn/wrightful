# 2026-05-25 — Reporter posts a PR comment when a run completes

## What changed

Added an opt-in `postPrComment` reporter option. When enabled and the run
finishes from inside a GitHub Actions PR workflow, the reporter posts (or
upserts) a summary comment on the PR with status, tallies, and a deep link
to the dashboard run page.

The comment is posted from CI — not from the dashboard. The runner's
`GITHUB_TOKEN` is used directly; no GitHub App, no per-tenant install
state, no dashboard-side integration. A GitHub App is the longer-term
answer if/when we want check runs, status checks, or non-Actions runners,
but this gets the common case shipped with zero new infra.

## Details

New module `packages/reporter/src/pr-comment.ts`:

- `shouldPostPrComment(enabled, ci, env)` — gating: option enabled, CI is
  `github-actions`, `prNumber` set, `repo` set, token present. Token
  source is `WRIGHTFUL_GITHUB_TOKEN` (override) then `GITHUB_TOKEN`.
- `buildCommentBody(summary)` — markdown body. Includes hidden marker
  `<!-- wrightful:pr-comment -->`, status emoji + label, a table of
  passed / failed (failed+timedout merged) / flaky / skipped / duration,
  a link to the run, and optional environment + short commit SHA lines.
- `postPrComment(summary, token)` — lists the last 100 issue comments
  (desc by creation), looks for the marker, and either `PATCH`es the
  found comment or `POST`s a new one. Listing failures are non-fatal:
  fall through to POST.

Wiring (`packages/reporter/src/index.ts`):

- New `runUrl`, `ci`, and per-status `counts` fields on the reporter.
- `StreamClient.openRun` now returns `{ runId, runUrl }` — `runUrl` was
  already in the dashboard's response, the reporter just hadn't been
  capturing it.
- `enqueueDone` tallies per-status counts as tests finalize.
- After `completeRun` succeeds in `onEnd`, `maybePostPrComment` runs the
  gate and (if it passes) calls the poster. Any error is logged via the
  existing `warn` helper and swallowed — the reporter must never fail
  the suite over a missing PR comment. Cross-fork PRs hit 403 because
  the runner's `GITHUB_TOKEN` is read-only; that's the canonical case
  for the warn-and-continue path.

| Field           | Type      | Default | Notes                                               |
| --------------- | --------- | ------- | --------------------------------------------------- |
| `postPrComment` | `boolean` | `false` | Opt-in. Silent skip when env doesn't meet the gate. |

Required workflow permission for callers:

```yaml
permissions:
  contents: read
  pull-requests: write
```

## Tests

`packages/reporter/src/__tests__/pr-comment.test.ts` covers:

- `shouldPostPrComment` — every refusal branch + happy path + token override.
- `buildCommentBody` — marker present, link absolute, tallies + duration
  formatting, failed+timedout collapse, env / sha lines, null runUrl
  falls back to dashboard origin.
- `postPrComment` — upsert path (PATCH), create path (POST), listing
  500 falls through to POST, terminal 403 throws.

Updated `client.test.ts` to expect `runUrl` in the `openRun` return.

## Verification

- `pnpm --filter @wrightful/reporter test` — 136/136 ✓
- `pnpm test` — dashboard + reporter unit tests, 333 + 136 ✓
- `pnpm exec vp check -- packages/reporter/src` — 0 errors (pre-existing
  `as` warnings on `await response.json()` patterns; matches the rest of
  `client.ts`).
- `pnpm exec tsgo --noEmit` (in `packages/reporter`) — clean.
- Manual end-to-end is unverified — needs a real PR workflow run. The
  unit tests cover the happy path and the documented error modes.

## Follow-ups

- Per-environment marker if we want multiple runs (e.g. different
  `environment`) to post separate comments on the same PR. Today the
  marker is a single shared key so the last run wins.
- GitHub App / Check Runs are still the right answer for non-Actions
  runners and richer surfacing — track separately when there's demand.
