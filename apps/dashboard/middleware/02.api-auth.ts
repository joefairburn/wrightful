import { defineMiddleware } from "void";
import {
  negotiateVersionOrResponse,
  requireApiKeyOrResponse,
} from "@/lib/api-auth";
import { isIngestRoute } from "@/lib/ingest-routes";
import { checkRateLimit, clientIp, tooManyRequests } from "@/lib/rate-limit";

/**
 * API-key + protocol-version gate for the reporter ingest endpoints.
 *
 * Scoped to the bearer-authenticated routes:
 *   - POST /api/runs                       (open a run)
 *   - POST /api/runs/:id/results           (append a batch)
 *   - POST /api/runs/:id/complete          (finalize)
 *   - POST /api/artifacts/register         (reserve row + return worker upload URL)
 *   - PUT  /api/artifacts/:id/upload       (stream into R2 through the worker)
 *
 * Explicitly NOT applied to:
 *   - /api/artifacts/:id/download — signed HMAC token in `?t=`, not bearer keys
 *   - /api/auth/*                 — Better Auth (void/auth)
 *   - /api/invites/*, /api/user/* — session auth
 *   - /api/t/*                    — session auth (dashboard cookie)
 *
 * Stashes `c.var.apiKey` on success so handlers can pull it via `getApiKey(c)`.
 * Required as global middleware (rather than per-route) because the
 * `defineHandler.withValidator(...)` curry doesn't accept middleware in the
 * chain — see comments in `src/lib/api-auth.ts`.
 *
 * The ingest route set is owned by `isIngestRoute` (`src/lib/ingest-routes.ts`)
 * so this Bearer gate and the `03.rate-limit.ts` throttle gate stay in lockstep.
 */
export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  if (!isIngestRoute(path)) {
    await next();
    return;
  }
  // Pre-auth IP backstop. This must run BEFORE the Bearer lookup: a failed
  // auth returns from this middleware without ever reaching 03.rate-limit's
  // per-key gate, so without this check an unauthenticated client could spray
  // bogus keys at an unbounded rate (each attempt costing a D1 prefix SELECT
  // + SHA-256). The binding is generous (see wrangler.jsonc) — legit CI flows
  // are governed by the per-key API_RATE_LIMITER in 03.
  const ipAllowed = await checkRateLimit(
    c.env,
    "INGEST_IP_RATE_LIMITER",
    clientIp(c.req.raw),
  );
  if (!ipAllowed) return tooManyRequests(60);
  const apiResp = await requireApiKeyOrResponse(c);
  if (apiResp instanceof Response) return apiResp;
  const versionResp = negotiateVersionOrResponse(c);
  if (versionResp) return versionResp;
  await next();
});
