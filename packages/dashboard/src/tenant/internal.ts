// Raw DO access. Not re-exported from `./index.ts` and deliberately behind
// a different module path so `grep "tenant/internal"` surfaces every caller
// in review. Everything here SKIPS the membership / API-key check that the
// public `tenantScopeFor*` helpers perform.
//
// **Allowed importers:**
//   1. `src/tenant/*` — trusted construction of `TenantScope` instances.
//   2. `src/scheduled.ts` — cron watchdog fans out to every team DO and
//      has no per-request user to authorize against.
//
// **Not allowed elsewhere.** Route handlers / RSC pages / lib helpers must
// route through `tenantScopeForUser` / `tenantScopeForApiKey` instead. The
// lint rule in `.oxlintrc.json` enforces this at review time.

import { env } from "cloudflare:workers";
import { type Compilable } from "kysely";
import { createDoDb } from "@/lib/db/create-do-db";
import type { TenantDatabase } from "./index";
import type { TenantDO } from "./tenant-do";

/** Raw worker-side Kysely handle. No auth. Use a `TenantScope` if possible. */
export function getTenantDb(teamId: string) {
  return createDoDb<TenantDatabase>(env.TENANT, teamId);
}

/** Raw atomic batch. No auth. Use a `TenantScope` if possible. */
export async function batchTenant(
  teamId: string,
  queries: readonly Compilable[],
): Promise<void> {
  if (queries.length === 0) return;
  const compiled = queries.map((q) => {
    const c = q.compile();
    return { sql: c.sql, parameters: c.parameters };
  });
  const stub = env.TENANT.get(env.TENANT.idFromName(teamId));
  await stub.batchExecute(compiled);
}

/**
 * Raw DO stub. Intended for the cron watchdog only — it iterates every
 * team DO and has no user / API-key context to authorize against.
 */
export function internalTenantStubForCron(teamId: string) {
  return env.TENANT.get(env.TENANT.idFromName(teamId));
}

export type { TenantDO };
