import { defineHandler } from "void";
import { env } from "void/env";
import { getApiKey } from "@/lib/api-auth";
import { registerArtifacts } from "@/lib/artifacts";
import { tenantScopeForApiKey } from "@/lib/scope";
import { RegisterArtifactsPayloadSchema } from "@/lib/schemas";

/**
 * POST /api/artifacts/register
 *
 * Auth + translate over `registerArtifacts` (see `@/lib/artifacts` for the
 * reserve-row + idempotency + worker-upload-URL pipeline and the orphan-row
 * invariant). The returned `uploadUrl` is a relative worker path
 * (`/api/artifacts/:id/upload`) — bytes are PUT through the worker into R2, not
 * to a presigned R2 host.
 */
export const POST = defineHandler.withValidator({
  body: RegisterArtifactsPayloadSchema,
})(async (c, { body: payload }) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await registerArtifacts(
    scope,
    payload,
    env.WRIGHTFUL_MAX_ARTIFACT_BYTES,
    nowSeconds,
  );

  switch (result.kind) {
    case "oversized":
      return c.json(
        {
          error: `Artifact "${result.name}" exceeds the ${result.maxBytes}-byte limit`,
          maxBytes: result.maxBytes,
        },
        413,
      );
    case "runNotFound":
      return c.json({ error: "Run not found" }, 404);
    case "runClosed":
      // Terminal + idle past the write grace window: registering would hand
      // back overwrite upload URLs for historical artifacts. 4xx → terminal
      // for the reporter (no retry).
      return c.json(
        { error: "Run completed too long ago to accept writes" },
        409,
      );
    case "unknownTestResults":
      return c.json(
        {
          error: "One or more testResultId values do not belong to this run",
          unknownTestResultIds: result.unknownTestResultIds,
        },
        400,
      );
    case "ok":
      return c.json({ uploads: result.uploads }, 201);
  }
});
