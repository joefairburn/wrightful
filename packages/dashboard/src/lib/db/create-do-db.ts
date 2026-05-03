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

// Replacement for rwsdk's `createDb`. Critical difference: we do NOT fire a
// separate `stub.initialize()` RPC per query.
//
// rwsdk's version (node_modules/rwsdk/dist/runtime/lib/db/createDb.js):
//   stub.initialize();                    // fire-and-forget extra RPC
//   return stub.kyselyExecuteQuery(...);  // DO already calls initialize() internally here
//
// Both RPCs queue at the DO's input gate, doubling per-query latency under
// any contention. Skipping the worker-side initialize halves RPC volume to
// ControlDO and the per-team TenantDOs. Migration safety is unchanged: the
// DO's `kyselyExecuteQuery` (in `SqliteDurableObject`) still awaits
// `this.initialize()` before running SQL, AND each DO subclass calls
// `ctx.blockConcurrencyWhile(() => this.initialize())` in its constructor
// so migrations run once per cold start regardless of incoming concurrency.
//
// Important: the DO stub is acquired *per query*, not at construction time.
// Better Auth's factory is module-cached (`getAuth()` in lib/better-auth.ts),
// so the Kysely instance lives across requests. A stub captured at
// construction would belong to the request that first instantiated it; using
// it from a later request triggers Cloudflare's "Cannot perform I/O on
// behalf of a different request" guard. Resolving the stub inside
// `executeQuery` keeps every RPC tied to the current request's I/O context.

interface DoStub {
  kyselyExecuteQuery(query: {
    sql: string;
    parameters: readonly unknown[];
  }): Promise<unknown>;
}

interface DoBinding {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DoStub;
}

class DoConnection implements DatabaseConnection {
  constructor(
    private readonly binding: DoBinding,
    private readonly name: string,
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const stub = this.binding.get(this.binding.idFromName(this.name));
    const result = await stub.kyselyExecuteQuery({
      sql: compiledQuery.sql,
      parameters: compiledQuery.parameters,
    });
    return result as QueryResult<R>;
  }

  // eslint-disable-next-line require-yield
  async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
    throw new Error("DO Driver does not support streaming");
  }
}

class DoDriver implements Driver {
  constructor(
    private readonly binding: DoBinding,
    private readonly name: string,
  ) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new DoConnection(this.binding, this.name);
  }
  async beginTransaction(): Promise<void> {
    throw new Error("Transactions are not supported on the DO worker dialect");
  }
  async commitTransaction(): Promise<void> {
    throw new Error("Transactions are not supported on the DO worker dialect");
  }
  async rollbackTransaction(): Promise<void> {
    throw new Error("Transactions are not supported on the DO worker dialect");
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class DoDialect {
  constructor(
    private readonly binding: DoBinding,
    private readonly name: string,
  ) {}
  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver() {
    return new DoDriver(this.binding, this.name);
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }
}

export function createDoDb<DatabaseType>(
  binding: DoBinding,
  name: string,
): Kysely<DatabaseType> {
  return new Kysely<DatabaseType>({ dialect: new DoDialect(binding, name) });
}
