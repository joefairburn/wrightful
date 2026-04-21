import { env } from "cloudflare:workers";
import { CamelCasePlugin, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { DB } from "./schema";

// Control D1 database. Single static binding (`env.DB`).
//
// CamelCasePlugin converts camelCase identifiers in TS to snake_case in SQL,
// so our queries and Better Auth's kyselyAdapter both issue statements like
// `SELECT userId FROM session WHERE id = ?` which compile to
// `SELECT user_id FROM session WHERE id = ?` against the existing columns.

export function getDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new D1Dialect({ database: env.DB }),
    plugins: [new CamelCasePlugin()],
  });
}

export type Db = Kysely<DB>;
