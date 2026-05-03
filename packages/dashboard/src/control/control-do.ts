import { SqliteDurableObject } from "rwsdk/db";
import { controlMigrations } from "./migrations";

/**
 * Singleton Durable Object holding all auth/tenancy data: users, sessions,
 * accounts, verifications, teams, projects, memberships, api keys, invites,
 * userOrganizations.
 *
 * Addressed by name `"control"`. Registered under the `CONTROL` binding in
 * `wrangler.jsonc`. The worker entry re-exports this class so the Workers
 * runtime can find it. Migrations run lazily on first access via rwsdk's
 * `await this.initialize()` pattern; subsequent requests skip the check via
 * the in-memory `initialized` flag (DO instances persist across requests,
 * unlike Worker isolates).
 */
export class ControlDO extends SqliteDurableObject {
  migrations = controlMigrations;

  // Disable rwsdk's default `ParseJSONResultsPlugin`. Better Auth stores its
  // OAuth `verification.value` as a JSON string and calls `JSON.parse()` on
  // read; auto-parsing on the DO side would hand it back an object, and
  // `JSON.parse(obj)` then throws `SyntaxError: "[object Object]" is not
  // valid JSON` on every GitHub callback.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, controlMigrations, "__migrations", []);
    // Run migrations atomically before any RPC is admitted. Without this,
    // rwsdk's `SqliteDurableObject.initialize()` races: concurrent RPCs all
    // read `this.initialized = false` past the in-memory check, then each
    // independently runs the migrator (~88 ms wall on ControlDO). Cloudflare
    // observability showed this consistently — every concurrent cold-start
    // RPC paid the full migration cost. `blockConcurrencyWhile` queues all
    // incoming RPCs until the passed promise resolves, so the migrator runs
    // exactly once per DO instance.
    void ctx.blockConcurrencyWhile(() => this.initialize());
  }

  /**
   * Execute a sequence of pre-compiled SQL statements atomically inside the
   * ControlDO's SQLite instance. Mirror of `TenantDO.batchExecute`. Used by
   * `batchControl` for atomic multi-statement writes (membership creation,
   * team setup, etc.) where partial application would leave the system in a
   * confusing state.
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
        this.ctx.storage.sql
          .exec(q.sql, ...(q.parameters as unknown[]))
          .toArray();
      }
    });
  }
}
