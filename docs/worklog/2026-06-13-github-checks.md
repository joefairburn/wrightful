# 2026-06-13 — GitHub Checks via a dashboard-side GitHub App (roadmap 1.3)

## What changed

When a run completes, the dashboard now posts a **GitHub check run** (pass/fail/flaky + a link to the run report) on the run's head commit, so test results can gate PR merges. Implemented as a **dashboard-side GitHub App** rather than reporter-side:

- a check run needs an _installation_ token (only a GitHub App mints one), which — unlike a CI `GITHUB_TOKEN` — works on **fork PRs**, the case that matters most for gating;
- the dashboard owns the authoritative post-`completeRun` aggregates and the canonical run URL;
- runs finalized by the stale-run watchdog (CI killed before `/complete`) never reach reporter `onEnd`, but still flow through the same posting path.

The reporter's existing `postPrComment` is unchanged and remains the no-App fallback for self-hosters.

Lifecycle: a team owner installs the App from the team General settings page (the install link carries `state=<teamSlug>`). GitHub redirects to the setup callback, which links the installation to the team. The `installation.deleted` webhook removes the link. On each terminal run, `maybePostGithubCheck` resolves the installation from the run's repo owner, mints an installation token, and POSTs (or PATCHes, on a re-complete) the check run.

## Details

| Area   | Change                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema | New `githubInstallations` table (`id`, `teamId` FK cascade, `installationId` unique, `accountLogin` unique, timestamps); `runs.githubCheckRunId` (nullable int) for idempotent POST→PATCH. Migration `20260613163514_true_the_stranger.sql`.                                                                                                    |
| Env    | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM), `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` — all optional.                                                                                                                                                                                                                          |
| Config | `githubAppEnabled(source)` in `src/lib/config.ts` (all three creds present).                                                                                                                                                                                                                                                                    |
| Lib    | `src/lib/github-app.ts` — `mintAppJwt` (RS256 via WebCrypto), `mintInstallationToken`, `fetchInstallationAccountLogin`, `verifyWebhookSignature` (HMAC), `parseRepoOwner`, `githubFetch`. `src/lib/github-checks.ts` — `statusToConclusion` + `buildCheckRunOutput` (pure), `postCheckRun`, `maybePostGithubCheck` (best-effort, never throws). |
| Ingest | `completeRun` + `finalizeStaleRun` `await maybePostGithubCheck(runId)`.                                                                                                                                                                                                                                                                         |
| Routes | `routes/api/github/webhook.ts` (HMAC-verified; `installation.deleted` cleanup), `routes/api/github/setup.ts` (session + owner-gated install callback).                                                                                                                                                                                          |
| UI     | "GitHub checks" card on the team General settings page (connection status + owner-only install link).                                                                                                                                                                                                                                           |

## Design notes

- **No-op is cheap.** `maybePostGithubCheck` first checks `githubAppEnabled(env)` (no DB/network) and returns immediately when the App isn't configured — the common case for local/self-host — so the terminal ingest path is unaffected.
- **Never fails ingest.** All GitHub I/O is wrapped; errors are logged via `logger.error` and swallowed. A GitHub outage can't fail `/complete`.
- **Row creation is the setup callback's job, not the webhook's.** Only the setup flow knows which Wrightful team an installation belongs to (from the install `state`); the `installation.created` event has no team context. The webhook handles `deleted` (cleanup) and ignores `created`.
- **`accountLogin` is the resolution key.** A run's `repo` ("owner/name") → owner → the installation row. The unique index on `accountLogin` means one GitHub org maps to one team (a second team claiming the same org gets a friendly error on setup).
- **PKCS#8 requirement.** WebCrypto's `importKey("pkcs8")` only accepts PKCS#8; env.ts documents converting GitHub's default PKCS#1 key with `openssl pkcs8`.

## Verification

- `vp exec tsgo --noEmit` — clean.
- `vp test run` — **892 passed (85 files)**. New `github-app.test.ts` (repo-owner parse; webhook HMAC verify against a Node reference signature; RS256 App-JWT shape + signature verified with a throwaway keypair's public half) and `github-checks.test.ts` (`statusToConclusion`, `buildCheckRunOutput`). The `ingest-pipeline` suite got a `void/env` mock (empty → App disabled → `maybePostGithubCheck` no-ops) so its `completeRun` assertions are unchanged.
- `vp check` — 0 errors (73 warnings: 70 pre-existing reporter + 3 new `response.json() as T` casts matching the established idiom).
- `void db generate` — migration generated and inspected.
- Not exercised: live GitHub App install + check posting (requires a registered App + installation). The pure cores + crypto are unit-tested; the GitHub API exchanges are integration-only.
