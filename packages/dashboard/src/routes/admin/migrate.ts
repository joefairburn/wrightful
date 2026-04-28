import { env } from "cloudflare:workers";
import type { RouteMiddleware } from "rwsdk/router";
import { migrateControlDb } from "@/db/migrate";

/**
 * POST /api/admin/migrate
 *
 * Apply pending control-D1 migrations. Bearer-authed with `MIGRATE_SECRET`
 * (a Worker secret + matching CF Builds env var). Hit by CI immediately
 * after `wrangler deploy`. Bypasses the API-key middleware that fronts the
 * rest of `/api`, so it's mounted alongside the `/api/auth/*` route — both
 * are exempt from the API-key requireAuth chain.
 */
export const migrateHandler: RouteMiddleware = async ({ request }) => {
  const expected = env.MIGRATE_SECRET;
  if (!expected) {
    return Response.json(
      { error: "MIGRATE_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }
  if (request.headers.get("Authorization") !== `Bearer ${expected}`) {
    return new Response(null, { status: 403 });
  }

  const result = await migrateControlDb();
  if (result.error) {
    const message =
      result.error instanceof Error
        ? result.error.message
        : JSON.stringify(result.error);
    return Response.json(
      { error: message, results: result.results },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, applied: result.results ?? [] });
};
