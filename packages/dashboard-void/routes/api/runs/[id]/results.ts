import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { AppendResultsPayloadSchema } from "@/lib/schemas";
import { appendRunResults } from "@/lib/ingest";

/**
 * POST /api/runs/:id/results — append a batch of test results. See
 * `appendRunResults` in `@/lib/ingest` for the batch semantics; the handler
 * is auth + translation only.
 */
export const POST = defineHandler.withValidator({
  body: AppendResultsPayloadSchema,
})(async (c, { body: payload }) => {
  const runId = c.req.param("id");
  if (!runId) return c.json({ error: "Not found" }, 404);

  const scope = await tenantScopeForApiKey(getApiKey(c));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await appendRunResults(scope, runId, payload, nowSeconds);

  if (result.kind === "notFound") {
    return c.json({ error: "Run not found" }, 404);
  }
  return c.json({ results: result.mapping }, 200);
});
