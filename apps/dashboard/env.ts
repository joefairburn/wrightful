import { boolean, defineEnv, number, string, url } from "void/env";

export default defineEnv({
  /**
   * Public origin for the dashboard. Used by void auth for OAuth callback
   * URLs and for building artifact download links sent back to the reporter.
   * Local dev: http://localhost:5173. Production: set via `void secret put`.
   */
  WRIGHTFUL_PUBLIC_URL: url(),

  /**
   * Auth signing secret. ≥32 chars (generate with `openssl rand -base64 32`).
   * Drives Better Auth's session cookie HMAC and our short-lived artifact
   * download tokens. On Void Cloud this is auto-created if unset.
   */
  BETTER_AUTH_SECRET: string().secret(),

  /**
   * Optional dedicated secret for signing short-lived artifact download tokens.
   * Decouples those (low-value, broadly-minted, HTML-embeddable) capabilities
   * from the session-signing BETTER_AUTH_SECRET: with it set, a leaked artifact
   * token is revoked by rotating THIS secret without logging out every user.
   * Falls back to BETTER_AUTH_SECRET when unset (backward compatible). ≥32 chars.
   * The fallback precedence is owned by `resolveArtifactTokenSecret` in
   * src/lib/config.ts — see it before changing this rule.
   */
  ARTIFACT_TOKEN_SECRET: string().secret().optional(),

  /**
   * GitHub OAuth credentials, in Void's `AUTH_<PROVIDER>_CLIENT_{ID,SECRET}`
   * naming convention. The github social provider is enabled in `auth.ts` at
   * startup only when BOTH are set — deliberately NOT declared in
   * `void.json#auth.providers` (which lists only "email"), because declaring it
   * there would make Void hard-require these creds on every deploy. Leave both
   * unset to hide the "Continue with GitHub" button.
   */
  AUTH_GITHUB_CLIENT_ID: string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: string().secret().optional(),

  // ---------- GitHub App (check runs) ----------

  /**
   * GitHub App credentials for posting check runs that gate PR merges. The
   * feature is enabled only when ALL of APP_ID + PRIVATE_KEY + WEBHOOK_SECRET
   * are set (`githubAppEnabled` in `src/lib/config.ts`); leave them unset to
   * disable. Distinct from the OAuth `AUTH_GITHUB_*` creds (sign-in) — a check
   * run needs an *installation* token, which only a GitHub App can mint, and
   * works on fork PRs where a CI `GITHUB_TOKEN` is read-only.
   *
   * `GITHUB_APP_PRIVATE_KEY` must be a **PKCS#8** PEM (`BEGIN PRIVATE KEY`);
   * convert GitHub's default PKCS#1 key with
   * `openssl pkcs8 -topk8 -nocrypt -in key.pem`. WebCrypto's `importKey("pkcs8")`
   * only accepts PKCS#8.
   */
  GITHUB_APP_ID: string().optional(),
  GITHUB_APP_PRIVATE_KEY: string().secret().optional(),
  GITHUB_APP_WEBHOOK_SECRET: string().secret().optional(),

  /**
   * The GitHub App's public slug (from its settings URL,
   * `github.com/apps/<slug>`). Used to build the "Install" link on the team
   * settings page. Optional — without it the settings card shows manual setup
   * instructions instead of a one-click install button.
   */
  GITHUB_APP_SLUG: string().optional(),

  /**
   * Per-artifact upload size cap. The cap binds in exactly one place:
   * /api/artifacts/register rejects any artifact whose declared sizeBytes
   * exceeds it with a 413. /api/artifacts/:id/upload does NOT re-read the cap —
   * it only asserts the incoming Content-Length equals the already-registered
   * sizeBytes, which is transitively cap-bound because an oversized artifact
   * never gets a row at register. Lowering the cap therefore only affects
   * future registrations, not already-registered in-flight uploads. Default
   * 50 MiB.
   */
  WRIGHTFUL_MAX_ARTIFACT_BYTES: number().default(52428800),

  /**
   * Minutes a run can sit at status='running' before the cron watchdog marks
   * it 'interrupted'. Default 30 — longer than any realistic single test run,
   * shorter than someone-checks-the-dashboard-the-next-morning.
   */
  WRIGHTFUL_RUN_STALE_MINUTES: number().default(30),

  /**
   * Max stale runs the watchdog cron finalizes per invocation. Caps the sweep so
   * a mass-stranding event (an ingest outage leaving thousands of runs stuck at
   * status='running') can't make the cron self-DoS: each finalize is ~2 serial
   * D1/RPC round-trips, so an unbounded drain blows the Workers subrequest/CPU
   * budget and gets killed mid-pass. With a bounded slice each pass makes
   * guaranteed forward progress and the backlog drains across successive runs
   * (each pass re-scans only still-'running' rows). Default 200 — well under the
   * subrequest cap at ~2 round-trips/run, with headroom for the SELECT itself.
   */
  WRIGHTFUL_SWEEP_BATCH_SIZE: number().default(200),

  // ---------- Billing / usage quotas ----------

  /**
   * `'free'`-tier monthly run-open allowance. `checkQuota` (`src/lib/usage.ts`)
   * blocks `POST /api/runs` once a team's `usageCounters.runsCount` for the
   * current month would exceed this. Non-free tiers are unlimited (no block).
   * Default 1000.
   */
  WRIGHTFUL_FREE_MONTHLY_RUNS: number().default(1000),

  /**
   * `'free'`-tier monthly test-result allowance. Metered (fresh testResults
   * rows per month) but NOT hard-blocked in v1 — surfaced on the usage page and
   * used for the soft-warn signal. Default 100000.
   */
  WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS: number().default(100000),

  /**
   * `'free'`-tier monthly artifact-byte allowance (R2). `registerArtifacts`
   * blocks once a team's `usageCounters.artifactBytes` for the month would
   * exceed this — enforced on FRESH bytes only, so an idempotent re-registration
   * is never blocked. Default 5 GiB.
   */
  WRIGHTFUL_FREE_ARTIFACT_BYTES: number().default(5368709120),

  /**
   * Percent of a tier limit at which `checkQuota` returns `softWarn` (the
   * ingest response sets an `X-Wrightful-Quota-Warning` header and the usage
   * page shows an amber bar) before the hard block at 100%. Default 90.
   */
  WRIGHTFUL_QUOTA_SOFT_WARN_PCT: number().default(90),

  // ---------- Data retention ----------

  /**
   * Default age (DAYS) after which artifact R2 objects + rows are swept, when a
   * team hasn't set its own `retentionArtifactDays`. The storage-cost axis —
   * shorter than run history because bytes (traces/videos) dominate R2 spend.
   * Must stay ≤ `WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS`. Default 30.
   */
  WRIGHTFUL_RETENTION_ARTIFACT_DAYS: number().default(30),

  /**
   * Default age (DAYS) after which `testResults` rows (+ their cascaded
   * attempts/tags/annotations/artifact rows) are swept, when a team hasn't set
   * its own `retentionTestResultsDays`. The D1-size axis; `runs` summary rows
   * are kept (they hold the aggregate counters). Default 90.
   */
  WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS: number().default(90),

  /**
   * Max rows of EACH retention axis the sweep deletes per project per cron
   * invocation. Bounds the per-pass D1 + R2 work so a large backlog drains
   * across successive daily passes instead of blowing the subrequest budget.
   * Mirrors `WRIGHTFUL_SWEEP_BATCH_SIZE`. Default 200.
   */
  WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE: number().default(200),

  /**
   * Enable open email/password signup. Off by default — email verification
   * isn't wired yet, so self-hosters running multi-user need to leave this
   * `false` and create users via invites.
   */
  ALLOW_OPEN_SIGNUP: boolean().default(false),

  // ---------- Synthetic monitoring ----------

  /**
   * Max due monitors the sweep cron enqueues per invocation. Bounds the cheap
   * select+enqueue pass so a backlog can't blow the 30s sub-hour cron CPU
   * budget; the backlog drains across successive 1-minute ticks. Mirrors
   * `WRIGHTFUL_SWEEP_BATCH_SIZE`. Default 200.
   */
  WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE: number().default(200),

  /**
   * Per-project cap on the number of BROWSER monitors. A coarse abuse/cost
   * guardrail — each browser monitor multiplies scheduled container runs.
   * Default 25. (HTTP monitors have their own, higher cap below — they're a
   * plain `fetch()`, far cheaper, so users make many.)
   */
  WRIGHTFUL_MONITOR_MAX_PER_PROJECT: number().default(25),

  /**
   * Per-project cap on HTTP (uptime) monitors. Separate from the browser cap
   * because an http check is a plain `fetch()` from the queue consumer — no
   * container, ~free — so a project can hold many without eating its browser
   * budget. Enforced by a TYPE-SCOPED `countMonitors(scope, "http")`, so the two
   * caps never cross-contaminate. Default 50.
   */
  WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT: number().default(50),

  /**
   * Max bytes of an HTTP check's response body the executor buffers for
   * body/JSON assertions (read is truncated past this). Bounds Worker memory +
   * the CPU of evaluating a body assertion against a huge payload. The stored
   * `resultDetail.bodyExcerpt` is a much smaller ≤2 KiB slice, kept only when a
   * body assertion failed. Default 256 KiB.
   */
  WRIGHTFUL_HTTP_CHECK_MAX_BODY_BYTES: number().default(262144),

  /**
   * Which `MonitorExecutor` the queue consumer uses. `'sandbox'` (default) runs
   * the user's Playwright in a Void Sandbox container. `'stub'` synthesizes a
   * deterministic run in-process with no container — used by tests and local
   * dev so the full schedule→queue→ingest pipeline is exercisable without Docker.
   */
  WRIGHTFUL_MONITOR_EXECUTOR: string().default("sandbox"),

  /**
   * Hard per-execution wall-clock cap (seconds) for a synthetic browser run.
   * Bounds container cost and stops a runaway user script. Default 300 (5 min).
   *
   * Coupled to `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES`: the reaper cutoff
   * must stay above `maxRetries × this + queue dwell` or a legitimately
   * slow/retrying execution gets reaped mid-flight. If you raise this, raise the
   * stale window too (defaults: 3 × 5 min = 15 min, comfortably under 30 min).
   */
  WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS: number().default(300),

  /**
   * Minutes a monitor execution can sit non-terminal (`queued`/`running`) before
   * the reaper cron flips it to `error`. Covers an enqueue send that failed
   * (stuck `queued`) or a Worker evicted mid-run (stuck `running`); without it
   * those rows leak forever and skew uptime. Also bounds the synthetic-key
   * sweeper's orphan window. Must comfortably exceed a full retry lifecycle
   * (`maxRetries` × `MAX_DURATION_SECONDS` + queue dwell) so a legitimately
   * slow/retrying execution is never reaped mid-flight. Default 30 — mirrors
   * `WRIGHTFUL_RUN_STALE_MINUTES`, and well past 3 × 5 min.
   */
  WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES: number().default(30),

  /**
   * OPTIONAL override for the secret authenticating the server's internal
   * DO-to-DO room-publish POST (ingest → `void/ws` room `onRequest` → broadcast).
   * Normally you do NOT set this: a per-build random is baked into the server
   * bundle at build time (`vite.config.ts` → `__WRIGHTFUL_INTERNAL_SECRET__`),
   * which the publisher worker + the room DOs share because they're one
   * deployment — zero config, auto-rotates per deploy, decoupled from
   * BETTER_AUTH_SECRET. Set this only to PIN a stable value across deploys.
   * Precedence (this → build secret; it deliberately NEVER falls back to
   * BETTER_AUTH_SECRET) lives in `resolveInternalSecret`
   * (src/realtime/room-server.ts). Server-only; travels DO-to-DO over
   * Cloudflare's internal RPC, never the public internet. ≥32 chars.
   */
  REALTIME_INTERNAL_SECRET: string().secret().optional(),
});
