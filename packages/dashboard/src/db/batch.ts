import type { Compilable } from "kysely";
import { env } from "cloudflare:workers";

// D1 caps: 100 bound parameters per statement, 1000 statements per batch. The
// per-statement cap is a data-shape concern — callers that build multi-row
// INSERTs must chunk their value arrays themselves. The per-batch cap is
// enforced here.
const MAX_STATEMENTS_PER_BATCH = 1000;

/**
 * Execute a sequence of Kysely queries atomically via D1's native `batch()`.
 *
 * Kysely-d1's dialect wraps `env.DB.prepare()` / `.run()` but doesn't expose
 * `batch()`. We drop to the raw binding for that, compiling each query
 * individually and binding its parameters — the CamelCasePlugin and any
 * other plugins on the Kysely instance run during `.compile()`, so the SQL
 * handed to D1 already has its identifiers transformed.
 */
export async function batchD1(queries: readonly Compilable[]): Promise<void> {
  if (queries.length === 0) return;
  const db = env.DB;
  const prepared = queries.map((q) => {
    const compiled = q.compile();
    return db.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
  });
  for (let i = 0; i < prepared.length; i += MAX_STATEMENTS_PER_BATCH) {
    const chunk = prepared.slice(i, i + MAX_STATEMENTS_PER_BATCH);
    if (chunk.length === 0) continue;
    await db.batch(chunk as [D1PreparedStatement, ...D1PreparedStatement[]]);
  }
}
