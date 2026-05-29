import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { OpenRunPayloadSchema } from "@/lib/schemas";
import { backdatingAllowed, openRun } from "@/lib/ingest";

function runUrl(scope: { teamSlug: string; projectSlug: string }, id: string) {
  return `/t/${scope.teamSlug}/p/${scope.projectSlug}/runs/${id}`;
}

/**
 * POST /api/runs — open a streaming run. Idempotent on
 * `(projectId, idempotencyKey)` — see `openRun` in `@/lib/ingest`.
 *
 * Auth + version negotiation run in `middleware/02.api-auth.ts`, which sets
 * `c.var.apiKey` before the handler executes.
 */
export const POST = defineHandler.withValidator({
  body: OpenRunPayloadSchema,
})(async (c, { body: payload }) => {
  if (payload.createdAt !== undefined && !backdatingAllowed()) {
    return c.json(
      { error: "createdAt override is only allowed in local development" },
      400,
    );
  }

  const scope = await tenantScopeForApiKey(getApiKey(c));
  const nowSeconds = payload.createdAt ?? Math.floor(Date.now() / 1000);
  const { runId, duplicate } = await openRun(scope, payload, nowSeconds);

  return c.json(
    {
      runId,
      runUrl: runUrl(scope, runId),
      ...(duplicate ? { duplicate: true } : {}),
    },
    duplicate ? 200 : 201,
  );
});
