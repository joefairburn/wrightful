import { type Migration, sql } from "kysely";
// Vite's `?raw` suffix inlines the file's text into the worker bundle at
// build time. The `.sql` files stay on disk so `wrangler d1 migrations
// apply DB --local` keeps working for local dev — the bundle and the
// filesystem are the same source of truth.
import init from "../../migrations/0000_init.sql?raw";

/**
 * Control-D1 migrations applied via Kysely's `Migrator` from inside the
 * worker. Triggered post-deploy by a one-shot POST to `/api/admin/migrate`
 * (see `src/routes/admin/migrate.ts`).
 *
 * Pre-launch policy: edit `0000_init` in place; don't stack numbered
 * migrations.
 *
 * D1 doesn't accept multi-statement queries through its public API, so we
 * split on the `--> statement-breakpoint` markers the SQL file already uses
 * and execute each statement individually.
 */
function statements(source: string): string[] {
  return source
    .split("--> statement-breakpoint")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

export const controlMigrations: Record<string, Migration> = {
  "0000_init": {
    async up(db) {
      for (const stmt of statements(init)) {
        await sql.raw(stmt).execute(db);
      }
    },
  },
};
