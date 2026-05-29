# Dual DB

Make the dashboard buildable against either D1 (default, free, easy, capped at 10 GB) or Postgres via Hyperdrive (self-host/production, no size ceiling). Dialect is chosen at build/deploy time via `WRIGHTFUL_DB=d1|pg`; the same source tree builds either worker.

## Why both

- **D1** — zero-ops, free tier, fine for individuals and small teams. The right floor.
- **Postgres** — D1's 10 GB per-database ceiling is a hard wall, not a soft one. Anyone running this in production needs an escape hatch before they hit it.

A documented D1 → PG upgrade path is more valuable than picking one engine.

## What Void gives us for free

- `void.json` → `"database": "pg"` plus `DATABASE_URL` is the entire platform switch. Void provisions Hyperdrive on deploy and keeps the same `void/db` Drizzle handle + migration commands (`void db generate/migrate`).
- Better Auth's tables are bootstrapped by `void/auth` against whichever dialect is active — no porting on that surface.
- PG even gets transactional DDL, which is nicer than D1.

## What we have to build

### 1. Single `db/schema.ts`, dialect chosen at import

```ts
// db/schema.ts
import { table, text, integer, index, uniqueIndex } from "./_dialect";
// ...rest of the schema is unchanged.
```

`db/_dialect.ts` re-exports either `void/schema-d1` (aliasing `sqliteTable as table`) or `void/schema-pg` (aliasing `pgTable as table`). Drizzle's column-builder names line up across dialects (`text`, `integer`, `index`, `uniqueIndex` all exist on both), so the schema body is identical source.

Timestamps stay as epoch-second `integer` columns on both engines (PG widens to `bigint` via the shim). This avoids touching any application code that reads timestamps.

### 2. `WRIGHTFUL_DB=d1|pg` env, read in `vite.config.ts`

The build-time env drives:

- which `_dialect.ts` variant is exported,
- which migration directory is active (`db/migrations/d1/` vs `db/migrations/pg/`),
- which `void.json` is in effect (`void.d1.json` / `void.pg.json` — copied or symlinked to `void.json` at build, or selected via a small config plugin).

### 3. `dialectSql()` helper for the one portability gap

`src/lib/analytics/bucketing-sql.ts` has the only non-portable SQL fragment today:

```ts
sql`strftime('%Y-%m', runs."createdAt", 'unixepoch')`;
```

Replace with a dialect-aware lookup:

```ts
const monthBucket = {
  d1: sql`strftime('%Y-%m', runs."createdAt", 'unixepoch')`,
  pg: sql`to_char(to_timestamp(runs."createdAt"), 'YYYY-MM')`,
}[DIALECT];
```

The other two bucket branches (`/ 86400`, `/ 604800`) are portable as-is. If more dialect-specific SQL crops up later, this helper is the one place it grows.

### 4. Two migration directories — kept in lockstep

Generated SQL diverges (type names, transactional DDL, index syntax), so we maintain `db/migrations/d1/` and `db/migrations/pg/` in parallel forever.

**Discipline rule:** every schema change in a PR runs `void db generate` under both envs. Add a pre-push or CI check that fails when only one migrations directory changed — otherwise the PG path will silently rot.

## Tests

Run the dialect-sensitive tests under both engines; let the rest run once.

### What needs both dialects

- Route handlers and page loaders that hit the DB.
- `src/lib/*` helpers that build Drizzle queries (`runs-filters-where`, `branches-query`, `scope`, `authz`, ingest, analytics).
- The migration smoke test (apply all migrations from empty → assert schema).

### What runs once (dialect-agnostic)

- Pure logic: Zod schemas, `bucketing.ts` math, API-key hashing, anything in `src/lib/` that doesn't touch `db`.
- Component/UI tests.

### Test infra

```
src/__tests__/helpers/
  void-db-stub.ts        # dispatches based on WRIGHTFUL_DB
  void-db-stub.d1.ts     # better-sqlite3 (current setup)
  void-db-stub.pg.ts     # pglite (embedded PG in WASM)
```

Prefer **pglite** over testcontainers — embedded PG with the same in-process lifecycle as our existing SQLite stub. Zero infra in CI, ~30 MB extra. Real-PG-in-CI (services block + schema-per-test) is the fallback if pglite limitations bite.

### CI matrix

- `WRIGHTFUL_DB=d1 vitest` and `WRIGHTFUL_DB=pg vitest` as two jobs.
- Wall-clock cost: ~+30–40% on the test job (non-DB tests duplicate cheaply, DB tests are the real value).

## Risks and caveats

- **pglite is not 100% real Postgres** — limited extension support, some concurrency edge cases differ. Fine for our surface (CRUD, indexes, simple aggregations). If we ever reach for `LISTEN/NOTIFY`, full-text search, or PG-specific extensions, we outgrow pglite and need real PG in CI. Not on the current horizon.
- **Two migration histories** is the real ongoing tax. The lockstep CI check is non-optional.
- **Data migration D1 → PG** is a separate problem and out of scope for the build-time toggle. Provide a one-shot export/import script when someone actually needs it.

## Rollout

1. Land the dialect shim + `_dialect.ts` (no behavior change; D1 stays default).
2. Wire `WRIGHTFUL_DB` into `vite.config.ts`, generate the second `void.json`.
3. Generate the PG migration set from the current schema; check both into the repo.
4. Add pglite-backed test stub; parameterize the existing DB tests.
5. Add the CI matrix entry and the "both migration dirs changed" guard.
6. Document the upgrade path for self-hosters (separate worklog).

Estimated effort: ~1 day for the scaffolding, then a small per-PR tax (~5–10 min to regenerate both migration sets on schema changes).
