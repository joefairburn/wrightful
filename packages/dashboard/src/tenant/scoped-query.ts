import {
  type DeleteQueryBuilder,
  type DeleteResult,
  type InsertObject,
  type InsertQueryBuilder,
  type InsertResult,
  type Kysely,
  type SelectQueryBuilder,
  type UpdateObject,
  type UpdateQueryBuilder,
  type UpdateResult,
} from "kysely";
import type { AuthorizedProjectId, TenantDatabase } from "./index";

/**
 * Tables in the tenant DO that carry a `projectId` column. Every read or
 * write against one of these is scoped to a single project — that's the
 * invariant the `TenantScope` API enforces structurally.
 */
export type ScopedTable =
  | "runs"
  | "testResults"
  | "testTags"
  | "testAnnotations"
  | "testResultAttempts"
  | "artifacts";

type ScopedRow<T extends ScopedTable> = TenantDatabase[T];

type ScopedKyselyDb = Kysely<TenantDatabase>;

/**
 * Insert builder bound to a `TenantScope`. The values type omits
 * `projectId` (so a caller can't write into the wrong project) and the
 * scope's `projectId` is injected at runtime.
 */
export interface ScopedInsertBuilder<T extends ScopedTable> {
  values(
    rows:
      | Omit<InsertObject<TenantDatabase, T>, "projectId">
      | ReadonlyArray<Omit<InsertObject<TenantDatabase, T>, "projectId">>,
  ): InsertQueryBuilder<TenantDatabase, T, InsertResult>;
}

/**
 * Update builder bound to a `TenantScope`. `.set` omits `projectId` (you
 * can't move a row across projects) and `.where("projectId", …)` is
 * pre-applied so a forgotten predicate can't widen the update across the
 * tenant.
 */
export interface ScopedUpdateBuilder<T extends ScopedTable> {
  set(
    values: Omit<UpdateObject<TenantDatabase, T, T>, "projectId">,
  ): UpdateQueryBuilder<TenantDatabase, T, T, UpdateResult>;
}

interface ScopeBindings {
  readonly db: ScopedKyselyDb;
  readonly projectId: AuthorizedProjectId;
}

// Kysely's where/values overloads infer column-name and value types from
// the table parameter. The runtime calls are correct (every scoped table
// has a `projectId text NOT NULL` column — see `migrations.ts`), but TS
// can't see across the `T extends ScopedTable` generic, so each call
// site needs an opaque cast. Centralising them here keeps the noise out
// of public types.

export function scopedSelect<T extends ScopedTable>(
  bindings: ScopeBindings,
  table: T,
): SelectQueryBuilder<TenantDatabase, T, ScopedRow<T>> {
  const base = bindings.db.selectFrom(table) as unknown as SelectQueryBuilder<
    TenantDatabase,
    T,
    ScopedRow<T>
  >;
  return (base.where as (col: string, op: string, val: unknown) => typeof base)(
    `${table}.projectId`,
    "=",
    bindings.projectId,
  );
}

export function scopedInsert<T extends ScopedTable>(
  bindings: ScopeBindings,
  table: T,
): ScopedInsertBuilder<T> {
  return {
    values(rows) {
      const inject = (row: object) => ({
        ...row,
        projectId: bindings.projectId,
      });
      const withProjectId = Array.isArray(rows)
        ? rows.map(inject)
        : inject(rows as object);
      return bindings.db
        .insertInto(table)
        .values(withProjectId as unknown as InsertObject<TenantDatabase, T>);
    },
  };
}

export function scopedUpdate<T extends ScopedTable>(
  bindings: ScopeBindings,
  table: T,
): ScopedUpdateBuilder<T> {
  return {
    set(values) {
      const base = bindings.db.updateTable(
        table,
      ) as unknown as UpdateQueryBuilder<TenantDatabase, T, T, UpdateResult>;
      const withSet = base.set(
        values as unknown as UpdateObject<TenantDatabase, T, T>,
      );
      return (
        withSet.where as (
          col: string,
          op: string,
          val: unknown,
        ) => typeof withSet
      )(`${table}.projectId`, "=", bindings.projectId);
    },
  };
}

export function scopedDelete<T extends ScopedTable>(
  bindings: ScopeBindings,
  table: T,
): DeleteQueryBuilder<TenantDatabase, T, DeleteResult> {
  const base = bindings.db.deleteFrom(table) as unknown as DeleteQueryBuilder<
    TenantDatabase,
    T,
    DeleteResult
  >;
  return (base.where as (col: string, op: string, val: unknown) => typeof base)(
    `${table}.projectId`,
    "=",
    bindings.projectId,
  );
}
