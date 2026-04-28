import { Migrator } from "kysely";
import { InMemoryMigrationProvider } from "rwsdk/db";
import { getDb } from "./index";
import { controlMigrations } from "./migrations";

/**
 * Apply pending control-D1 migrations and return Kysely's
 * `MigrationResultSet`. Idempotent — Kysely tracks applied migrations in
 * `__migrations` and serializes concurrent runs through `__migrations_lock`,
 * so calling this when nothing's pending is just a couple of D1 reads.
 *
 * Used by the `/api/admin/migrate` post-deploy hook. Tenant-DO migrations
 * have their own lazy-on-first-access path inside `SqliteDurableObject`.
 */
export async function migrateControlDb() {
  const migrator = new Migrator({
    db: getDb(),
    provider: new InMemoryMigrationProvider(controlMigrations),
    migrationTableName: "__migrations",
    migrationLockTableName: "__migrations_lock",
  });
  return migrator.migrateToLatest();
}
