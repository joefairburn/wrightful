// Raw worker-side Kysely handle for the singleton ControlDO. Kept in a
// separate module so the public surface in `./index.ts` stays small.

import { env } from "cloudflare:workers";
import { type Compilable } from "kysely";
import { createDoDb } from "@/lib/db/create-do-db";
import type { ControlDatabase } from "./index";

/**
 * The singleton ControlDO is always addressed by the same name. Any worker
 * isolate, anywhere, talks to the same DO instance — that's how this works.
 */
const CONTROL_NAME = "control";

/**
 * Worker-side Kysely handle backed by the singleton ControlDO. Returns a
 * `Kysely<ControlDatabase>` whose schema is inferred from the migration DSL.
 *
 * Uses our `createDoDb` (not rwsdk's `createDb`) so we don't fire a redundant
 * `stub.initialize()` RPC per query — see `src/lib/db/create-do-db.ts`. The
 * DO still runs migrations on cold start via `blockConcurrencyWhile` in its
 * constructor.
 */
export function getControlDb() {
  return createDoDb<ControlDatabase>(env.CONTROL, CONTROL_NAME);
}

/**
 * Execute a sequence of Kysely queries atomically against the ControlDO.
 * Compiles each query on the worker, sends the tuple list to the DO via
 * RPC, where it's wrapped in `ctx.storage.transactionSync` for all-or-
 * nothing semantics.
 */
export async function batchControl(
  queries: readonly Compilable[],
): Promise<void> {
  if (queries.length === 0) return;
  const compiled = queries.map((q) => {
    const c = q.compile();
    return { sql: c.sql, parameters: c.parameters };
  });
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await stub.batchExecute(compiled);
}
