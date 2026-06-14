/**
 * The bearer-authenticated reporter ingest surface, as a single predicate.
 *
 * "These ingest routes must each require a Bearer key AND be throttled
 * per-tenant" is one invariant, but it was previously expressed twice — the
 * same two regex literals lived byte-for-byte in both `middleware/02.api-auth.ts`
 * (the Bearer gate) and `middleware/03.rate-limit.ts` (the throttle gate). A
 * maintainer renaming `/api/runs` or adding a new ingest route had to remember
 * to edit both, and nothing failed at build or test time if they drifted:
 *   - authed in 02 but not throttled in 03 → unbounded per-tenant D1 writes.
 *   - throttled in 03 but not authed in 02 → handler calls `getApiKey(c)`, which
 *     throws because 02 never stashed the key → a 500 instead of a clean 401.
 *
 * Both gates now import `isIngestRoute`, so the route set lives in exactly one
 * place and the two cannot drift.
 *
 * The covered routes:
 *   - POST /api/runs                 (open a run)
 *   - POST /api/runs/:id/results     (append a batch)
 *   - POST /api/runs/:id/complete    (finalize)
 *   - POST /api/artifacts/register   (reserve row + return worker upload URL)
 *   - PUT  /api/artifacts/:id/upload (stream into R2 through the worker)
 *
 * Deliberately NOT covered (each has a single consumer in 03 only; folding them
 * in would be a pass-through, not a concentration):
 *   - /api/auth/*                 → AUTH_RATE_LIMITER     (IP-keyed)
 *   - /api/artifacts/:id/download → ARTIFACT_RATE_LIMITER (artifactId-keyed)
 */
const RUN_INGEST_RE = /^\/api\/runs(?:\/|$)/;
const ARTIFACT_INGEST_RE =
  /^\/api\/artifacts\/(?:register|[^/]+\/upload)(?:\/|$)/;

/**
 * `true` when `path` is a Bearer-authenticated reporter ingest route — i.e. a
 * route the auth gate (02) must require a key for AND the throttle gate (03)
 * must key by `apiKey.id`. The single source of truth for that invariant.
 */
export function isIngestRoute(path: string): boolean {
  return RUN_INGEST_RE.test(path) || ARTIFACT_INGEST_RE.test(path);
}

/**
 * The Bearer-authenticated PUBLIC QUERY / EXPORT surface (`/api/v1/*`), as a
 * single predicate — the read-path sibling of {@link isIngestRoute} (roadmap
 * 2.5). Same source-of-truth rationale: both the auth gate (02) and the
 * throttle gate (03) import it so the two can't drift.
 *
 * It is DELIBERATELY a separate auth branch from ingest, not a folding-in:
 *
 *   - 02.api-auth does Bearer lookup + `getApiKey` stash here, but NOT
 *     `negotiateVersionOrResponse`. The query API is a stable read contract for
 *     CLIs/scripts/spreadsheets and carries no `X-Wrightful-Version` handshake,
 *     so a missing/invalid key answers a clean 401 — there is NO 409 version
 *     path on this surface (which is what proves the branch is distinct from
 *     ingest's version-gated path).
 *   - 03.rate-limit throttles `/api/v1/*` under the looser `QUERY_RATE_LIMITER`
 *     (a read pull, possibly large CSV pages, is not the high-frequency
 *     small-write shape `API_RATE_LIMITER` is budgeted for), still keyed by
 *     `apiKey.id` with an IP fallback.
 *
 * `/api/v1/*` is a fresh, versioned namespace with no overlap with the ingest
 * routes (`/api/runs/*`, `/api/artifacts/*`) or the session-authed `/api/t/*`,
 * so the two predicates are disjoint over every `/api/*` path — asserted in
 * `src/__tests__/ingest-routes.test.ts`.
 */
const QUERY_API_RE = /^\/api\/v1(?:\/|$)/;

export function isQueryApiRoute(path: string): boolean {
  return QUERY_API_RE.test(path);
}
