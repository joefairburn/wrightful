import { type Database } from "rwsdk/db";
import { controlMigrations } from "./migrations";
import { ControlDO } from "./control-do";

export { ControlDO };
export { getControlDb, batchControl } from "./internal";

/**
 * Control schema type, inferred directly from the migration DSL in
 * `./migrations.ts`. Adding or removing columns updates the inferred type
 * automatically — no hand-maintained interface file.
 */
export type ControlDatabase = Database<typeof controlMigrations>;

/** Membership role values used across auth/tenancy code. */
export type MembershipRole = "owner" | "member";
