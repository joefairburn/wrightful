# Wrightful — In-Depth MVP Review (2026-05-29)

**Scope:** high-level architecture, security, DX, and general code quality.
**Context:** pre-launch MVP the team wants to feel confident shipping; a substantial
refactor is expected to follow.

**Method:** a multi-agent review fanned out across 10 dimensions (subsystem maps →
per-dimension review → adversarial verification → synthesis), ~93 findings. Every
critical/high finding below was then re-verified by hand against the actual code
(grep + reading the cited files). The low-severity long tail had a high
verifier-error rate in the automated pass, so the P3 items carry lighter confidence
than the P0–P1 items, which were checked directly.

---

## Resolution status (2026-05-29, follow-up commit)

A follow-up pass implemented the bulk of this roadmap. `vp check` passes with 0
errors and all unit tests pass (dashboard + reporter, incl. new tests).

**Fixed:**

- **P0 — rate limiting wired** (`middleware/03.rate-limit.ts` + `checkRateLimit`
  in `rate-limit.ts`): auth (IP), ingest (apiKey.id), artifact download
  (artifactId), with a regression test (`__tests__/rate-limit.test.ts`).
- **Ingest errors → Cloudflare Tail** (`00.errors.ts` logs genuine `/api/*`
  errors before re-throw; `action-errors.ts` logs the unexpected branch of the
  settings mutations).
- **CI production-build gate** + `--frozen-lockfile` (`ci.yml`).
- **Reporter no longer calls `process.exit()`** — Playwright owns termination
  (`reporter/src/index.ts`); shutdown tests updated.
- **Sharding** — `completeRun` merges status monotonically (a failed shard can't
  be overwritten by a later passing one) + max duration/completedAt;
  duplicate-open prefills via `onConflictDoNothing` (`ingest.ts`); test added.
- **Watchdog** funnels through `finalizeStaleRun` (recompute + broadcast) with
  per-run error logging (`crons/sweep-stuck-runs.ts`).
- **`(projectId, createdAt)` index** on `testResults` (new migration) +
  **suite-size "tests added" query rewritten** to a window-bounded form.
- **Artifact registration is idempotent** (reuse existing row + R2 key on
  retry) + **filename sanitized** for the R2 key (`artifacts/register.ts`).
- **Ingest Zod bounds** (`schemas.ts`) — finite caps on all strings/arrays.
- **Security headers** restored at the edge in `void.json` `routing.headers`
  (added CSP — with the GitHub-avatar origin allowed — plus HSTS and
  Permissions-Policy; X-Frame-Options/nosniff/Referrer-Policy were already there).
- **`ARTIFACT_TOKEN_SECRET`** decoupled from `BETTER_AUTH_SECRET` (falls back;
  test added). **GitHub `read:org` scope dropped** (vestigial). **Version header
  now required.**
- **`/signup` page added** (gated on `ALLOW_OPEN_SIGNUP`) — dead link fixed.
- **`@wrightful/dashboard-void` → `@wrightful/dashboard`** filter fix in setup
  scripts.

**Deliberately deferred (with rationale):**

- **Live run-detail header** — a frontend island restructure (lift
  `useRunProgress` to drive the header) that needs visual verification in a
  running app; the backend now broadcasts live summaries + terminal events, so
  the data path is ready.
- **Full DB-backed integration tests** (validateApiKey, ownership rejection,
  openRun idempotency) — needs an in-memory D1 harness + a native `better-sqlite3`
  dev dep; DB-free coverage was added for token verify, status merge, and the
  rate limiter instead.
- **`ingest.ts` split** — a pure structural refactor; bundling it with behavior
  changes in still-untested code is risky. Do it as a dedicated PR.
- **R2 object deletion on tenant delete** — needs a queued/reconciliation job
  (inline deletion of many objects risks request timeout).
- ~~**e2e harness rework + re-enable**~~ — **DONE** (follow-up). The dashboard
  UI e2e suite (`packages/e2e/tests-dashboard`) was repointed to the Void
  dashboard (`apps/dashboard`, `.env.local`, `vp dev`, `void db reset`, the Void
  key API) and its specs reconciled to the shipped UI — now **35/35 green**.
  Running it surfaced (and this work fixed) several real bugs the static review
  missed: 404 pages returned HTTP 200; missing `<html lang>` / `<title>` /
  `aria` attributes (axe serious); anonymous deep-page visits 404'd instead of
  redirecting to `/login`; and the login/signup forms native-submitted
  (leaking credentials into the URL) before hydration. Still TODO: re-enable
  the CI job, and validate/rework the separate vitest dogfood `test:e2e` suite.
- **Explicit CSRF Origin-allowlist middleware** — `SameSite=Lax` +
  `frame-ancestors 'none'` + Better Auth's built-in checks cover the threat; a
  misconfigured allowlist risks breaking self-host.
- **Dead-code removal (CommandMenu/Toast), chip dedup, worklog index** —
  cosmetic.

---

## Bottom line

This is a genuinely well-built MVP with **one hard ship-blocker**. The core
engineering is strong: the ingest deep-module, the logical-tenancy model, the
artifact XSS defenses, and the reporter's "never break the user's suite" discipline
are all well done. **Tenant isolation held up under exhaustive scrutiny — no
exploitable cross-tenant leak** across 18 route handlers, 24 page loaders, the
ingest module, and the live socket.

**Verdict: shippable by maintainers who deploy carefully and know the gaps — not
push-button safe today.** Three patterns explain almost every finding:

1. **Designed-and-documented but never wired.** Rate limiting, retention, the live
   run-detail header, the Cmd-K menu, the Toaster — present in code or docs, none
   connected.
2. **The safety net is thinner than the green checkmarks imply.** No production-build
   gate in CI, both e2e jobs hard-disabled, ingest errors invisible to Cloudflare
   Tail, and zero tests on the security/data-integrity paths.
3. **The concurrency the design invites isn't fully handled.** Playwright sharding
   silently corrupts run aggregates.

The architecture is sound enough that the refactor should be framed as **"finish
wiring what's already designed + add the missing safety net,"** not "rethink the
foundations."

---

## 🔴 Ship-blocker: rate limiting is dead code

**Confirmed firsthand.** `wrangler.jsonc` declares three Cloudflare native limiters
(`AUTH_RATE_LIMITER` 20/60s, `API_RATE_LIMITER` 120/60s, `ARTIFACT_RATE_LIMITER`
300/60s) and `src/lib/rate-limit.ts` ships a `rateLimit()` middleware factory — but a
grep across `routes/`, `middleware/`, and `src/` finds **zero call sites** outside the
definition file. The bindings sit inert.

For a SaaS holding other people's CI credentials and data, this leaves wide open:

- **Login** (`/api/auth/*`) — credential stuffing on email+password.
- **Ingest** (Bearer) — brute-force / flooding that serializes on the single D1
  writer and degrades every tenant.
- **Artifact download** — unbounded byte egress (every byte proxies through the
  Worker).

The `void-migration-consolidated.md` worklog flagged this — _"declared … but not
provisioned/exercised — revisit before any real deploy"_ — and it shipped anyway.

**Fix (S):** add `middleware/03.rate-limit.ts` path-matching the three surfaces,
keyed by `clientIp` / `apiKey.id` (post-auth, tenant-scoped) / `artifactId`. Verify
the bindings materialize on the deployed worker, and add a 429 smoke test so it can't
silently regress.

---

## What's genuinely strong (keep through any refactor)

- **Ingest deep-module discipline.** Route handlers are thin auth+translation shims
  (`results.ts` is 27 lines) while the verify→batch→summary→broadcast pipeline lives
  behind `openRun`/`appendRunResults`/`completeRun` with real atomicity (`db.batch`),
  idempotency on `(projectId, idempotencyKey)`, ≤99-param chunking, and an
  authoritative `COUNT` recompute at completion. **Split during refactor — don't
  rewrite.**
- **Tenant isolation is real.** Every run-scoped query carries `projectId` (and
  `teamId` where present), denormalized to avoid joins. Settings routes 404 (not 403)
  to avoid existence leaks.
- **Credential primitives are correct.** 192-bit API keys, SHA-256 hash + 8-char
  prefix lookup + constant-time compare, plaintext shown once, revocation checked
  every validate, `lastUsedAt` moved off the latency path via `waitUntil`. Invite
  tokens hashed + recipient-bound; artifact tokens HMAC'd with timing-safe compare.
- **Artifact stored-XSS defense is layered** — content-type allowlist at register
  **and** re-sanitized at download, forced `Content-Disposition: attachment`,
  narrowed CORS, `encodeURIComponent`'d filename.
- **Exceptional hygiene for an MVP** — zero `console.*` in shipped source, zero
  `TODO/FIXME/HACK`, no `@ts-ignore`, narrow documented disables, `as` casts only at
  legitimate Drizzle/brand-minting points.
- **Disciplined Void frontend** — correct isomorphic loader model, islands at
  interactive leaves (not page roots), URL as canonical view state, SSR-safe
  accessible charts, correct FOUC-killer.

---

## 1. Architecture

The single-D1 + logical-tenancy decision (replacing per-team Durable Objects) is
well-reasoned and well-executed — the denormalized `teamId`/`projectId` on every
child table is the right call.

- **The branded `AuthorizedProjectId`/`AuthorizedTeamId` pattern is a clean guardrail,
  but be honest about what it is.** It is _compile-time-only_ — erased at runtime,
  minted by `as` casts on raw row strings. It reliably stops a developer from
  _forgetting_ a filter, but it **cannot catch an incorrect-but-present id** (a loader
  resolving the wrong project, or a child row written with the wrong `projectId`). In
  a single-D1 model, one wrong id silently leaks cross-tenant data. The denormalized
  `teamId` filters are good defense-in-depth, but the gap between "compile-time
  guardrail" and "runtime sandbox" should be stated in design docs and backed by the
  tenant-isolation tests that don't yet exist. (The casts themselves are at legitimate
  minting points, not abused — the issue is the type-only nature.)
- **`ingest.ts` (725 lines) is approaching god-module territory** with a fragile
  _implicit positional contract_ ("the summary is the last `db.batch` statement").
  During refactor, split into aggregate/statements/broadcast/orchestrator modules and
  make that contract explicit (named index, not position).
- **The watchdog cron bypasses the deep module.** `sweep-stuck-runs.ts` flips status
  to `interrupted` but never recomputes aggregates or broadcasts a terminal event — so
  SIGKILL'd runs ship with permanently drifted counts and live viewers hang on
  "running." Funnel it through a shared `finalizeStaleRun` helper alongside
  `completeRun`.

## 2. Security

| Area                    | Verdict                                                  |
| ----------------------- | -------------------------------------------------------- |
| Tenant isolation / IDOR | ✅ **Ship** — strongest dimension, no leaks found        |
| Artifact serving (XSS)  | ✅ **Ship** — triple-layer defense is robust             |
| Auth / abuse resistance | 🔴 **Fix first** — rate limiting dead code (the blocker) |

Beyond the ship-blocker, defense-in-depth gaps (not active leaks) to close:

- **Security headers (CSP, HSTS, Permissions-Policy) were lost in the migration** —
  they existed in the pre-Void review. CSP is the XSS containment layer; HSTS protects
  the session cookie from SSL-strip.
- **No Origin/CSRF check** on session-authed mutations beyond Better Auth's default
  `SameSite=Lax`. Add an explicit `Origin`/`Referer` check + `trustedOrigins`.
- **`BETTER_AUTH_SECRET` is dual-purpose** — it signs both session cookies and
  artifact download tokens, so a leaked artifact token can't be rotated without
  logging out every user. Introduce a dedicated `ARTIFACT_TOKEN_SECRET`.
- **Artifact tokens are unbound to user/project** (stateless bearer capability for one
  R2 key, 1h TTL). Real but narrow — the 1h TTL mitigates; the fix is the dedicated
  secret above so they're independently revocable.
- GitHub OAuth requests broad `read:org` scope and re-stores the token — narrow it;
  capture the login once.

## 3. Data model & scale → **Fix first**

The hot-path runs list is well-indexed, but analytics and retention are not ready to
store other people's CI history at scale:

- **No retention. Confirmed: nothing ever deletes anything.** The documented "two-axis
  retention" (30d artifacts / 90d runs) has zero deletion code — no `storage.delete()`
  / R2 delete anywhere, no `DELETE` on `runs`/`testResults`/`artifacts`. One active
  project produces tens of thousands of rows/day, all sharing one ~10GB-capped D1 and
  an unbounded R2 bill, with no purge path. (R2 bytes also survive team deletion — a
  soft data-residency concern.)
- **Missing `(projectId, createdAt)` index on `testResults`** — every
  flaky/tests/slowest/suite-size query filters exactly that predicate, forcing
  whole-project-partition scans. `0000_init` is frozen, so this goes in a new numbered
  migration.
- **`suite-size`'s "Tests Added" subquery scans the project's entire `testResults`
  history on every page render** with no time bound — the most unbounded query in the
  app, and it worsens precisely because nothing is ever deleted.
- **Single D1 is a shared-fate boundary**: one writer, serialized batch writes.
  Unthrottled ingest + unbounded retention + whole-partition analytics scans all
  converge here — one abusive/high-volume project degrades every tenant.

## 4. Ingest correctness → **Ship with caveats**

Excellent for the single-shard case. But:

- **Playwright sharding corrupts run aggregates. Confirmed.** `idempotencyKey =
generateIdempotencyKey(GITHUB_RUN_ID)` is identical across shards, so all shards
  collapse to one run. Shards 2..N hit the `duplicate:true` early-return (skipping
  queue prefill), per-status deltas race across non-serialized `UPDATE`s, and
  **whichever shard calls `/complete` last wins** — so a run where shard 2 _failed_ can
  be recorded `passed`. Either namespace the key per shard or document sharding as
  unsupported until fixed.
- **Artifact registration is non-idempotent** — a retried `/results` flush (which the
  reporter does on 5xx) duplicates artifact rows and re-uploads bytes (double
  storage/egress billing). Add a unique index on `artifacts(testResultId, name,
attempt)`.

## 5. Reporter DX → **Ship with caveats**

Unusually careful — `fetchWithRetry` with per-attempt timeouts, 4xx-no-retry,
fail-closed batching, quiet disable on missing token, realpath-sandboxed attachment
paths, a cross-package contract-test canary. One real issue:

- **The SIGTERM/SIGINT handler calls `process.exit(143|130)` directly**
  (`index.ts:305`), preempting Playwright's own graceful shutdown on every local
  Ctrl-C — truncating output and overriding the exit code Playwright would choose.
  Forward/re-raise the signal instead.

(Downgraded by verification: ESM-only publish is fine for modern Playwright configs;
"interrupted relabeled skipped" is cosmetic — aggregate status is correctly `failed`.)

## 6. DX / tooling / CI → **Fix first**

Inner loop is good (`pnpm install → setup:local → dev`, unified `vp check`). The
automation presents as a safety net but verifies less than it appears:

- **CI never runs the production build.** Only `vp check` + unit tests + reporter
  build. An SSR/worker-bundle break that typechecks and passes Vitest reaches `void
deploy` undetected. Add `vp build` after `void prepare`.
- **Both e2e jobs are `if: false`** and the harness resolves a non-existent
  `packages/dashboard` path with `.dev.vars` conventions Void replaced. There is zero
  browser/integration gate on the core reporter→ingest→UI path. Either rework the
  fixtures for `apps/dashboard` and re-enable one job, or delete the broken harness +
  misleading `test:e2e` script.
- **Local setup spawns `@wrightful/dashboard-void`** — a workspace that doesn't exist
  (it's `@wrightful/dashboard`). Dead-on-arrival for any path that spawns a fresh dev
  server; masked only when one is already running.
- **Ingest errors are invisible to Cloudflare Tail. Confirmed.** `00.errors.ts` does
  `if (isApi) throw err;` before the `logger.error` call, and server-action catches
  convert DB failures to friendly messages while discarding the original. You'll debug
  production ingest failures blind.

## 7. Frontend / general quality

- **The headline "watch your runs live" feature is half-delivered.** On run-detail,
  only the Tests tab subscribes to live events — the header (status glyph, OutcomeBar,
  summary pills, tab count) freezes at SSR values, and the live `summary` is computed,
  broadcast, then discarded as `_summary`. The runs list doesn't update live at all.
- **`/signup` is a dead link** — the login page renders "Create one" → `/signup` when
  `ALLOW_OPEN_SIGNUP` is true, but no such page/route exists (Better Auth only mounts
  the API endpoint). It's the first interaction on a fresh open-signup instance,
  landing on a 404.
- **Zero tests on the logic that matters.** Every dashboard test targets a pure
  helper. No tests for `openRun`/`appendRunResults`/`completeRun` (incl. the
  ownership-rejection paths that _are_ the tenant guard), `validateApiKey`, scope
  resolvers, or `verifyArtifactToken`. The brand types are compile-time-only, so they
  don't substitute. This is the single biggest gap behind "feel confident shipping."

---

## Prioritized roadmap

### P0 — before launch

| #   | Item                                                             | Effort |
| --- | ---------------------------------------------------------------- | ------ |
| 1   | **Wire up the rate limiters** (the one blocker) + 429 smoke test | S      |

### P1 — soon after / alongside launch

| #   | Item                                                                          | Effort |
| --- | ----------------------------------------------------------------------------- | ------ |
| 2   | Route ingest errors through `void/log`; stop swallowing DB errors             | S      |
| 3   | Add `vp build` to CI; fix or quarantine the e2e harness                       | S      |
| 4   | Fix reporter `process.exit()` signal handling                                 | S      |
| 5   | Resolve Playwright sharding (namespace key, or document unsupported)          | M      |
| 6   | Watchdog cron → shared `finalizeStaleRun` (recompute + broadcast)             | S      |
| 7   | Add `(projectId, createdAt)` index + manual purge script + retention env vars | M      |
| 8   | Make artifact registration idempotent                                         | S      |
| 9   | Integration tests: foreign-runId rejection, key validation, token verify      | M      |
| 10  | Live run-detail header; add `/signup` page or remove the link                 | M      |

### P2 — refactor

- Dedicated `ARTIFACT_TOKEN_SECRET`; restore CSP/HSTS/Permissions-Policy; add
  Origin/CSRF check + `trustedOrigins`; narrow GitHub scope.
- Split `ingest.ts`; make the positional batch contract explicit; derive the live
  `RunProgressTest` shape from the shared schema and guard it in the contract test.
- Add `.max()` bounds to all ingest Zod schemas (unbounded strings/arrays today);
  sanitize the artifact filename before the R2 key.
- Delete R2 bytes on team/project deletion.

### P3 — hygiene

- Dedupe the drifted chip helpers; delete the orphaned `CommandMenu` and unmounted
  `Toast`; back hand-rolled tab controls with the Base UI `Tabs` primitive.
- Enforce (not just advise) `X-Wrightful-Version`; `--frozen-lockfile` in CI; mark
  pre-Void worklogs historical with an index.
