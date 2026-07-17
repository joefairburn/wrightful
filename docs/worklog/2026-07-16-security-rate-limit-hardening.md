# Security / rate-limit / API hardening

Five review findings fixed in one pass: an unthrottled session API surface, a
targetable rate-limit key, webhook replayability, undocumented (unenforced)
MCP OAuth scopes, and a 403-vs-404 leak-posture inconsistency.

## What changed

### 1. Session tenant API (`/api/t/*`) is now rate-limited (MEDIUM)

`middleware/03.rate-limit.ts` only gated AUTH, artifact-download, ingest, and
the Bearer query surface; the cookie-authed `/api/t/:team/p/:project/*` family
fell through entirely — including `export/runs`, whose CSV cursor walk pages up
to `WRIGHTFUL_EXPORT_MAX_ROWS` at 500 rows/page.

- `src/lib/ingest-routes.ts`: new `isTenantApiRoute` predicate
  (`/^\/api\/t\/[^/]+\/p\/[^/]+(?:\/|$)/`) — the single source of truth for the
  family, disjoint from `isIngestRoute` / `isQueryApiRoute` (asserted in
  `src/__tests__/ingest-routes.workers.test.ts`).
- `middleware/03.rate-limit.ts`: new branch throttles the family under the
  existing `QUERY_RATE_LIMITER` (no new binding — same read/export budget shape
  as `/api/v1/*`), keyed by client IP. IP is the key because these requests are
  cookie-authed: no Bearer key is stashed and resolving the session in the
  throttle gate would add a DB read per request. 600/min/IP comfortably covers
  interactive dashboard use (search, diff, summaries) while bounding an
  export-hammering client.

### 2. Artifact-download limiter re-keyed to IP+artifactId (LOW)

The `ARTIFACT_RATE_LIMITER` was keyed on the bare `:id` path param — an
unauthenticated value, so anyone who learned an artifactId could exhaust that
artifact's budget and 429 legitimate viewers. `middleware/03.rate-limit.ts` now
keys it `${clientIp}:${artifactId}`: still per-file (the trace viewer's many
ranged chunks of one trace share a bucket), but per-caller, so a guessed id
can't deny the file to others. The no-valid-token-no-bytes property is
untouched — the handler still refuses bytes without the signed `?t=` token.

### 3. GitHub webhook replay guard (LOW)

`routes/api/github/webhook.ts` verified the HMAC correctly, but a captured
valid `installation.deleted` delivery could be re-POSTed to re-delete an
installation link. New `isReplayedDelivery(deliveryId)` in
`src/lib/github-http.ts` dedups on `X-GitHub-Delivery` via the Workers Cache
API (`caches.open`, 1h TTL) — chosen because the project has **no KV binding**
and the schema was out of scope (owned by another workstream). The handler
checks it only on the mutating `installation.deleted` branch and acks replays
with 200 (GitHub stops retrying on 2xx).

Documented limits (acceptable for this severity): the cache is per-colo and
best-effort, and the HMAC covers only the body, not the delivery-id header.
Residual impact is bounded by two facts recorded in the code: re-deleting an
already-removed row is idempotent, and GitHub never reuses installation ids, so
a replay after a genuine reinstall deletes nothing. Fails open (no dedup) when
`caches` is absent (non-Worker test contexts).

### 4. MCP OAuth scopes documented as intentionally unenforced (LOW)

`scopes` is captured on `McpTokenAuth` but never checked. Enforcement is
premature: every MCP tool is read-only (`readOnlyHint`) and every scoped call
runs a real membership check, so a scope string could neither widen nor need to
narrow the surface. Added explicit comments at both seams —
`src/lib/api-auth.ts` (where `scopes` is captured in
`requireMcpAuthOrResponse`) and `src/lib/mcp/server.ts` (the `McpAuthz` module
doc) — stating that scopes are NOT an authorization boundary today, and that a
future mutating tool must thread `scopes` into `McpAuthz` and gate in
`registerScopedTool` rather than shipping on `readOnlyHint` alone.

### 5. JSON routes now 404 (not 403) on missing-or-unauthorized (LOW)

Page seams (`settings-scope.ts`) and the session tenant API
(`tenant-api-scope.ts`) 404 on a missing resource OR insufficient role so
existence never leaks; four JSON routes answered 403 instead. Because
`AuthzError` / a null resolve **conflate** "missing" with "unauthorized", a 403
confirmed to a slug-prober or low-privilege member that the resource exists.
Changed to `404 { error: "Not found" }`:

- `routes/api/teams/[teamSlug]/p/[projectSlug]/keys.ts`
- `routes/api/teams/[teamSlug]/members.ts`
- `routes/api/teams/[teamSlug]/invites.ts`
- `routes/api/user/select-workspace.ts` (both team and project checks)

Judgement note: none of these are "caller provably knows the resource exists"
cases — the failure path fires exactly when the resolver could not confirm the
caller's right to know. Later in-handler statuses on already-authorized
resources (e.g. members.ts's 404 "member vanished", 409 last-owner) are
unchanged. No client branches on the status — all four consumers check
`res.ok` and read `body.error` (verified in `keys.tsx`, `members.tsx`,
`workspace-switcher.tsx`). Stale doc references to "403 JSON" in
`src/lib/settings-scope.ts` updated to match.

## Verification

- `vitest run src/__tests__/rate-limit.test.ts src/__tests__/rate-limit-config.test.ts src/__tests__/github-webhook-replay.test.ts` — 27 passed.
  New cases: tenant-API 429 + IP keying (incl. `export/runs`), artifact
  IP+id composite key, replay-guard first-seen/replay/fail-open, and a config
  drift guard pinning `isTenantApiRoute` wired in 03.
- `vitest run -c vitest.workers.config.ts src/__tests__/ingest-routes.workers.test.ts` — 14 passed
  (new `isTenantApiRoute` match set + disjointness from both Bearer surfaces).
- `vitest run -c vitest.workers.config.ts` for `mcp-server`, `mcp-auth`,
  `github-app`, `settings-scope`, `capability-gate` workers suites — 62 passed;
  `github-checks-claim.test.ts` — 5 passed.
- Not run (deferred to the coordinating full-verification pass, per parallel
  workstream rules): `pnpm check` (format/lint/typecheck) and the e2e suites.

No schema, migration, env, or wrangler binding changes.
