# 2026-06-14 — Architecture deepening: capability seam, run-diff orchestration, queue-consumer factory, form-flash seam, CI-scope brand, GitHub App identity, project teardown

## What changed

A pass of **architecture-deepening** refactors surfaced by a fan-out/adversarial-verify review (11 subsystem explorers → per-candidate adversarial verification against the real code). Of 22 raw candidates, 4 were confirmed deepenings, 4 were real-friction consolidations, and the rest were rejected or trivial. We implemented the 8 real findings plus two quick cleanups; the 4 rejected candidates and aesthetic-only items were deliberately skipped.

All changes are **behaviour-preserving** (no functional/UX change today) — they relocate decisions to a single home, close a seam bypass, or fix a latent bug. No schema changes, no migrations.

### Tier 1 — confirmed deepenings

1. **Capability matrix is now the sole authorization seam on the project axis too.** `roles.ts`'s `can(role, capability)` was reached at exactly one runtime site (the team path); every project-owner gate hand-rolled the literal `role === "owner"`, leaving `mintKeys`/`writeConfig` enforced at zero/one sites (inert vocabulary). Routed the four project gates through `can()`:
   - `gateOwnedProject` (`settings-scope.ts`) — now capability-keyed (default `mintKeys`), mirroring `gateTeamScope`; threads through `resolveOwnedProject` / `requireOwnedProjectScope`.
   - `requireOwnerTenantContext` (`tenant-context.ts`) — `can(role, "mintKeys")` (monitors transitively mint per-run keys).
   - `resolveOwnerTenantApiScope` (`tenant-api-scope.ts`) — `can(role, "writeConfig")` (quarantine + test-ownership are config writes).
   - `deleteProject` now passes `"writeConfig"` explicitly. Behaviour is byte-identical today (owner is the only role holding those caps); the win is locality — a future project-axis policy is one matrix cell, not four inline literals (a forgotten one is a priv-esc hole), and the gates inherit `roles.test.ts`'s coverage.

2. **`resolveRunDiff` — the run-diff head+base resolution + diff assembly has one home.** The decision-dense, 0%-tested recipe (head 404, self-compare guard, foreign-base-degrades-to-null, `diffRuns(base, head)` order) was duplicated verbatim in the page loader and the API route. Lifted into `resolveRunDiff(scope, runId, { baseParam })` in `run-diff.ts`; both adapters collapse to call → map `notFound` → shape output. New `run-diff-resolve.test.ts` pins the four branches.

3. **`createMonitorConsumer` — the two queue consumers share one body.** `queues/monitors.ts` and `queues/uptime.ts` were byte-identical except a log label and `retryDelay`. Extracted the per-message ack/retry/catch loop into the pure `consume-batch.ts` (`consumeMonitorBatch`, unit-tested) and the runtime wiring into `queue-consumer.ts` (`createMonitorConsumer`). Each queue file keeps only its three Void tuning consts + `export default createMonitorConsumer(...)`.

4. **Form-mutation flash seam adopted by the tenant routes + monitors action.** `quarantine.ts`, `owners.ts`, and the monitors create/update actions hand-rolled the `?xError=` redirect (local `toStr`, manual separator + `encodeURIComponent`, repeated `issues[0]?.message ?? fallback`). Routed them through the existing `redirectWithParam` + `readField`, and added `firstIssueMessage` to `form.ts` (collapses 6 sites). The error-flash wire format now lives in `form.ts` + `settings-scope.ts` only.

### Tier 2 — real-friction consolidations

5. **`ciRunsScopeRawWhere` — closed the one analytics loader sitting outside the branded scope.** `insights/run-duration.server.ts` hand-rolled its raw-SQL `runs`-table tenant predicate binding `projectId` ALONE (dropping `teamId`). Added the missing CI-scope family member (`analytics/filters.ts`) emitting `where runs."projectId" = ? and runs."teamId" = ? and runs.origin <> 'synthetic'` with both ids bound off the branded `TenantScope`; routed both CTEs through it. Test pins both ids are bound.

6. **GitHub App-identity seam.** `mintInstallationToken`/`fetchInstallationAccountLogin` (`github-app.ts`) now read the App creds (`appCredentials()`) + JWT clock internally; callers (`github-checks.ts`, `github/setup.ts`) shrink to a single `installationId` and drop their `!`-asserted env reads. The pure `mintAppJwt(appId, pem, now)` stays underneath for the JWT-claim test. (`setup.ts` keeps its `nowSeconds` local — reused for the `githubInstallations` row timestamps.)

7. **`project-teardown.ts` — the project-teardown duplication consolidated, atomicity preserved.** `deleteProject` and `deleteTeam` each open-coded "delete rows → `waitUntil` R2 sweep" and both redundantly `db.delete(apiKeys)` despite the FK cascade. The genuinely-shared half — the best-effort R2 byte sweep with log-and-continue — is now `scheduleProjectArtifactCleanup(c, teamId, projectId)`, called by both on the success path. The redundant `apiKeys` delete is dropped from both (every project-scoped child cascades via `onDelete: "cascade"` on `projects.id`). `deleteProject` uses `teardownProject` (single project: delete row → sweep). **`deleteTeam` keeps its single atomic `runBatch`** (all project rows + team-level rows in one all-or-nothing transaction — the guarantee `db-batch.ts` documents) and sweeps R2 per project only after it succeeds. (An earlier draft routed `deleteTeam` through a per-project `teardownProject` loop, which traded that atomic batch for a partially-committable loop and scheduled the sweep before the team-level delete succeeded — caught in adversarial review and reverted.)

8. **`leaveTeamGuarded` — the third guarded membership write joins the repo seam.** `leaveTeam` imported the raw `notLastOwner` predicate through a side door and open-coded the guarded `DELETE`. Added `members-repo.ts#leaveTeamGuarded` (narrower result — self-leave can't produce `noop` since membership is proven live by `requireMemberScope`); `leaveTeam` now calls it. The production side-door is closed; `notLastOwner` stays exported only for the repo's own predicate test.

### Quick cleanups

- **Dead code:** deleted `aggregateSummarySelectStatement` from `ingest.ts` (zero callers — confirmed) + its two prose references.
- **Latent bug:** `github-account-mirror.ts#captureGithubLogin`'s GitHub `/user` fetch (in the sign-in hook) had no timeout; added `AbortSignal.timeout(10_000)`. Kept inline rather than routed through `github-app.ts#githubFetch` — the mirror is loaded at `void prepare` config time via `auth.ts` and must not transitively import the `void/env` the App-auth seam now reads.

## Details

| Area      | New module                                                                | Notes                                                               |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| run-diff  | `resolveRunDiff` in `run-diff.ts`                                         | returns `{head, base, diff} \| {notFound:true}`                     |
| monitors  | `src/lib/monitors/consume-batch.ts`, `src/lib/monitors/queue-consumer.ts` | pure loop vs runtime wiring (mirrors the `executor.ts`/queue split) |
| analytics | `ciRunsScopeRawWhere` in `analytics/filters.ts`                           | runs-table raw-SQL scope fragment, binds `(projectId, teamId)`      |
| teardown  | `src/lib/project-teardown.ts`                                             | `teardownProject(c, teamId, projectId)`                             |
| members   | `leaveTeamGuarded` + `LeaveTeamResult` in `members-repo.ts`               |                                                                     |
| form      | `firstIssueMessage` in `form.ts`                                          |                                                                     |
| github    | `appCredentials()` (private) in `github-app.ts`                           | reads `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`                      |

New tests: `run-diff-resolve.test.ts` (5), `monitors/__tests__/consume-batch.test.ts` (4); extended `members-repo.test.ts`, `settings-scope.test.ts`, `analytics-filters.test.ts`.

### Deliberately NOT done

The 4 rejected candidates (artifacts signed-download "two paths"; the `uptime-vs-browser` monitor-kind predicate — its headline "ping bug" is unreachable; the per-test ranked-CTE lift; `runByIdWhere` non-adoption) and aesthetic-only items (stale-run watchdog file-move, monitor settle-constructor dedup, `chunkByParams` de-export). The verification judged these not worth the churn — see the review candidate notes.

## Verification

- `pnpm --filter @wrightful/dashboard exec vp check` — **0 errors**, 80 warnings (pre-existing baseline on unchanged lines).
- `pnpm --filter @wrightful/dashboard exec vp test run` — **1107 passed (102 files)** (was ~1085; +22 new assertions across the new/extended suites).
- No schema changes, no migrations, no functional/UX behaviour change.
