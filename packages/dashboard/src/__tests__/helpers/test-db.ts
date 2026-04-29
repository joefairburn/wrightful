import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import type { Compilable } from "kysely";
import type { ControlDatabase } from "@/control";
import type {
  AuthorizedProjectId,
  AuthorizedTeamId,
  TenantDatabase,
  TenantScope,
} from "@/tenant";

/**
 * In-test Kysely driver: records every compiled query and returns scripted
 * results in FIFO order. Anything that would hit the real ControlDO is
 * intercepted.
 *
 * Usage:
 *   const { db, driver } = makeTestDb();
 *   driver.results.push({ rows: [{ id: "r1" }], numAffectedRows: 1n });
 *   mockedGetControlDb.mockReturnValue(db);
 *   …assert on driver.queries[0].sql…
 */
export class ScriptedDriver implements Driver {
  readonly queries: CompiledQuery[] = [];
  readonly results: Array<QueryResult<Record<string, unknown>>> = [];

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const queries = this.queries;
    const results = this.results;
    return {
      async executeQuery<R>(
        compiledQuery: CompiledQuery,
      ): Promise<QueryResult<R>> {
        queries.push(compiledQuery);
        const next = results.shift();
        return (next ?? { rows: [] }) as QueryResult<R>;
      },
      // eslint-disable-next-line require-yield
      async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
        throw new Error("streamQuery not supported in ScriptedDriver");
      },
    };
  }

  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/**
 * Control-DB test Kysely. Mirrors the production `getControlDb()` config —
 * ControlDO uses camelCase columns in both TS and SQL, so no plugin layer.
 */
export function makeTestDb(): {
  db: Kysely<ControlDatabase>;
  driver: ScriptedDriver;
} {
  const driver = new ScriptedDriver();
  const db = new Kysely<ControlDatabase>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new SqliteIntrospector(d),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
  return { db, driver };
}

/**
 * Tenant-DO test Kysely. Mirrors the production `getTenantDb()` — no
 * CamelCasePlugin; columns are camelCase in both TS and the emitted SQL.
 */
export function makeTenantTestDb(): {
  db: Kysely<TenantDatabase>;
  driver: ScriptedDriver;
} {
  const driver = new ScriptedDriver();
  const db = new Kysely<TenantDatabase>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new SqliteIntrospector(d),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
  return { db, driver };
}

/**
 * Build a fake `TenantScope` over a test Kysely. For unit tests that mock
 * `tenantScopeForUser` / `tenantScopeForApiKey` and want the handler to
 * run real query-building against a scripted driver.
 */
export function makeTenantScope(opts: {
  db: Kysely<TenantDatabase>;
  teamId?: string;
  projectId?: string;
  teamSlug?: string;
  projectSlug?: string;
  batch?: (queries: readonly Compilable[]) => Promise<void>;
}): TenantScope {
  return {
    teamId: (opts.teamId ?? "team-1") as AuthorizedTeamId,
    teamSlug: opts.teamSlug ?? "t",
    projectId: (opts.projectId ?? "proj-1") as AuthorizedProjectId,
    projectSlug: opts.projectSlug ?? "p",
    db: opts.db,
    batch: opts.batch ?? (async () => {}),
  };
}

/** Shorthand for the common `{ rows: [...] }` response shape. */
export function selectResult(
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryResult<Record<string, unknown>> {
  return { rows: [...rows] };
}
