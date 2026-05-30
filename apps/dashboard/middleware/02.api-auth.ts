import { defineMiddleware } from "void";
import {
  negotiateVersionOrResponse,
  requireApiKeyOrResponse,
} from "@/lib/api-auth";

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
 */
const RUN_INGEST_RE = /^\/api\/runs(?:\/|$)/;
const ARTIFACT_INGEST_RE =
  /^\/api\/artifacts\/(?:register|[^/]+\/upload)(?:\/|$)/;

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  if (!RUN_INGEST_RE.test(path) && !ARTIFACT_INGEST_RE.test(path)) {
    await next();
    return;
  }
  const apiResp = await requireApiKeyOrResponse(c);
  if (apiResp instanceof Response) return apiResp;
  const versionResp = negotiateVersionOrResponse(c);
  if (versionResp) return versionResp;
  await next();
});
