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
import {
  scopedDelete,
  scopedInsert,
  scopedSelect,
  scopedUpdate,
} from "@/tenant/scoped-query";

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
 * run real query-building against a scripted driver. The scoped query
 * helpers are wired against `opts.db` so tests see the same projectId
 * predicate the production scope applies.
 */
export function makeTenantScope(opts: {
  db: Kysely<TenantDatabase>;
  teamId?: string;
  projectId?: string;
  teamSlug?: string;
  projectSlug?: string;
  batch?: (queries: readonly Compilable[]) => Promise<void>;
}): TenantScope {
  const teamId = (opts.teamId ?? "team-1") as AuthorizedTeamId;
  const projectId = (opts.projectId ?? "proj-1") as AuthorizedProjectId;
  const bindings = { db: opts.db, projectId };
  return {
    teamId,
    teamSlug: opts.teamSlug ?? "t",
    projectId,
    projectSlug: opts.projectSlug ?? "p",
    from: (table) => scopedSelect(bindings, table),
    insertInto: (table) => scopedInsert(bindings, table),
    updateTable: (table) => scopedUpdate(bindings, table),
    deleteFrom: (table) => scopedDelete(bindings, table),
    batch: opts.batch ?? (async () => {}),
  };
}

/** Shorthand for the common `{ rows: [...] }` response shape. */
export function selectResult(
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryResult<Record<string, unknown>> {
  return { rows: [...rows] };
}

/**
 * Convenience used inside `vi.mock("@/tenant", …)` factories. Returns a
 * fully-formed mock `TenantScope` over the supplied scripted db, with
 * `from / insertInto / updateTable / deleteFrom` wired through the same
 * scoped-query helpers production uses, so SQL assertions in tests see
 * the projectId predicate. Imports must happen inside the async factory.
 */
export function makeMockApiKeyScope(opts: {
  apiKey: { projectId: string } | null | undefined;
  tenantDb: Kysely<TenantDatabase> | null;
  teamId?: string;
  teamSlug?: string;
  projectSlug?: string;
  batchCalls?: Array<{ teamId: string; queries: Compilable[] }>;
}): TenantScope | null {
  if (!opts.apiKey || !opts.tenantDb) return null;
  return makeTenantScope({
    db: opts.tenantDb,
    teamId: opts.teamId,
    projectId: opts.apiKey.projectId,
    teamSlug: opts.teamSlug,
    projectSlug: opts.projectSlug,
    batch: opts.batchCalls
      ? async (queries) => {
          opts.batchCalls!.push({
            teamId: opts.teamId ?? "team-1",
            queries: [...queries],
          });
        }
      : undefined,
  });
}
