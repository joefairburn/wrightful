import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { tenantScopeForApiKey } from "@/lib/scope";
import { listQuarantine } from "@/lib/quarantine-repo";
import type { QuarantineResponse } from "@/lib/schemas";

/**
 * GET /api/runs/quarantine — the project's flaky-test quarantine list, which
 * the reporter pulls at `onBegin`. Returns `{ tests: [{ testId, mode, reason }]
 * }`; the reporter demotes a quarantined hard failure to `skipped` on the wire
 * (v1 enforcement — a reporter is observe-only and can't skip execution).
 *
 * `/api/runs/quarantine` matches `RUN_INGEST_RE` in `@/lib/ingest-routes`, so
 * Bearer auth + protocol-version negotiation run in `middleware/02.api-auth.ts`
 * (which sets `c.var.apiKey`) before this handler — no per-route gate needed.
 */
export const GET = defineHandler(async (c) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));
  const tests = await listQuarantine(scope);
  return c.json({ tests } satisfies QuarantineResponse);
});
