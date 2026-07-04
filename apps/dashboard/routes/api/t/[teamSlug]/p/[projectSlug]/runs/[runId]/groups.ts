import { defineHandler } from "void";
import { z } from "zod";
import {
  GROUP_BY_AXES,
  loadRunGroupSkeleton,
  STATUS_BUCKET_KEYS,
} from "@/lib/run-groups-page";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

const QuerySchema = z.object({
  groupBy: z.enum(GROUP_BY_AXES).optional(),
  status: z.enum(STATUS_BUCKET_KEYS).optional(),
  search: z.string().optional(),
});

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/groups
 *
 * The run-detail Tests-tab "group skeleton": one worst-first-ordered header per
 * group (file / Playwright project / shard) with its 4-bucket counts, for the
 * active status chip + search needle. Cheap (one GROUP BY over the run's rows);
 * the per-group ROWS are fetched lazily from `/results` on expand. The query
 * contract lives in `loadRunGroupSkeleton`; this handler is auth + translation.
 */
export const GET = defineHandler.withValidator({
  query: QuerySchema,
})(async (c, { query }) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  const result = await loadRunGroupSkeleton(scope, runId, {
    groupBy: query.groupBy ?? "file",
    status: query.status ?? null,
    search: query.search ?? null,
  });
  if (!result) return c.json({ error: "Not found" }, 404);
  return result;
});
