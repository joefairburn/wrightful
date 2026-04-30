import { SqliteDurableObject } from "rwsdk/db";
import { tenantMigrations } from "./migrations";

/**
 * One Durable Object per team. All tenant-owned data (runs, testResults,
 * testTags, testAnnotations, testResultAttempts, artifacts) lives here.
 *
 * Registered under the `TENANT` binding in `wrangler.jsonc`. The worker
 * entry re-exports this class so the Workers runtime can find it.
 */
export class TenantDO extends SqliteDurableObject {
  migrations = tenantMigrations;

  // Mirror of `ControlDO`: disable rwsdk's default `ParseJSONResultsPlugin`
  // so any JSON-shaped string column comes back as a raw string. Callers do
  // their own `JSON.parse` and would otherwise be handed an already-parsed
  // value, breaking `JSON.parse(obj)` with `"[object Object]" is not valid
  // JSON`.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, tenantMigrations, "__migrations", []);
  }

  /**
   * Execute a sequence of pre-compiled SQL statements atomically inside
   * this DO's SQLite instance. Neither `DOWorkerDialect` (worker side) nor
   * `kysely-do` (DO side) supports BEGIN/COMMIT through Kysely, so atomic
   * multi-statement writes live here: compile on the worker, send the tuple
   * list over RPC, wrap in `ctx.storage.transactionSync` for all-or-nothing
   * semantics.
   */
  async batchExecute(
    queries: ReadonlyArray<{
      sql: string;
      parameters: readonly unknown[];
    }>,
  ): Promise<void> {
    if (queries.length === 0) return;
    await this.initialize();
    this.ctx.storage.transactionSync(() => {
      for (const q of queries) {
        // `.toArray()` forces the cursor to drain inside the
        // transaction so any constraint error surfaces here (instead of
        // escaping as a lazy unhandled rejection on the next microtask).
        this.ctx.storage.sql
          .exec(q.sql, ...(q.parameters as unknown[]))
          .toArray();
      }
    });
  }

  /**
   * Finalize runs stuck at status='running' that were created before the
   * supplied `cutoffSeconds`. Invoked by the cron watchdog in
   * `src/scheduled.ts` — one RPC per active team, bounded by
   * `teams.lastActivityAt` upstream. Returns the swept rows so the caller
   * can emit per-run audit log lines.
   */
  async sweepStuckRuns(
    cutoffSeconds: number,
    nowSeconds: number,
  ): Promise<Array<{ id: string; createdAt: number }>> {
    await this.initialize();
    const cursor = this.ctx.storage.sql.exec<{
      id: string;
      createdAt: number;
    }>(
      `UPDATE "runs" SET "status" = ?, "completedAt" = ?
       WHERE "status" = ? AND "createdAt" < ?
       RETURNING "id", "createdAt"`,
      "interrupted",
      nowSeconds,
      "running",
      cutoffSeconds,
    );
    return cursor.toArray();
  }
}
