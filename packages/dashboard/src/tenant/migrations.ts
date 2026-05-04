import { type Migrations } from "rwsdk/db";

/**
 * Tenant-DO migrations. Run inside each team's `TenantDO` at `createDb()`
 * time via rwsdk/db's InMemoryMigrationProvider. TS types for the whole
 * tenant schema are inferred from the builders returned by `up()` — see
 * `Database<typeof tenantMigrations>` in `./index.ts`. No hand-written
 * interface required.
 *
 * Identifiers are camelCase in both TS and the emitted SQL. No plugin
 * layer — column names stored in SQLite match the names used in queries
 * verbatim, so rwsdk's inference pipeline stays coherent.
 *
 * The pre-M3 `committedRuns` view was dropped: views aren't inferable by
 * rwsdk/db, and `committed` is always `1` under streaming ingest anyway.
 * The legacy bulk-ingest two-phase commit (insert with committed=0, flip
 * to 1 on complete) is gone with this cut. Read paths that historically
 * used the view now filter on `runs.committed = 1` at the call site, or
 * skip the predicate entirely when they're already guarding on status.
 *
 * Migration policy (post-launch): `0000_init` is frozen — production DOs
 * have it applied. Schema changes go in new numbered migrations
 * (`0001_*`, `0002_*`, …) which run additively on existing tenant DOs.
 * Never edit a migration that has already been applied in any environment.
 */
export const tenantMigrations = {
  "0000_init": {
    async up(db) {
      const runs = await db.schema
        .createTable("runs")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("projectId", "text", (c) => c.notNull())
        .addColumn("idempotencyKey", "text")
        .addColumn("ciProvider", "text")
        .addColumn("ciBuildId", "text")
        .addColumn("branch", "text")
        .addColumn("environment", "text")
        .addColumn("commitSha", "text")
        .addColumn("commitMessage", "text")
        .addColumn("prNumber", "integer")
        .addColumn("repo", "text")
        .addColumn("actor", "text")
        .addColumn("totalTests", "integer", (c) => c.notNull())
        .addColumn("expectedTotalTests", "integer")
        .addColumn("passed", "integer", (c) => c.notNull())
        .addColumn("failed", "integer", (c) => c.notNull())
        .addColumn("flaky", "integer", (c) => c.notNull())
        .addColumn("skipped", "integer", (c) => c.notNull())
        .addColumn("durationMs", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("reporterVersion", "text")
        .addColumn("playwrightVersion", "text")
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .addColumn("completedAt", "integer")
        .addColumn("committed", "integer", (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .createIndex("runs_project_idempotency_key_idx")
        .unique()
        .on("runs")
        .columns(["projectId", "idempotencyKey"])
        .execute();
      await db.schema
        .createIndex("runs_ci_build_id_idx")
        .on("runs")
        .column("ciBuildId")
        .execute();
      await db.schema
        .createIndex("runs_branch_created_at_idx")
        .on("runs")
        .columns(["branch", "createdAt"])
        .execute();
      await db.schema
        .createIndex("runs_environment_created_at_idx")
        .on("runs")
        .columns(["environment", "createdAt"])
        .execute();
      await db.schema
        .createIndex("runs_project_created_at_idx")
        .on("runs")
        .columns(["projectId", "createdAt"])
        .execute();

      const testResults = await db.schema
        .createTable("testResults")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("runId", "text", (c) =>
          c.notNull().references("runs.id").onDelete("cascade"),
        )
        .addColumn("testId", "text", (c) => c.notNull())
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("file", "text", (c) => c.notNull())
        .addColumn("projectName", "text")
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("durationMs", "integer", (c) => c.notNull())
        .addColumn("retryCount", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("errorMessage", "text")
        .addColumn("errorStack", "text")
        .addColumn("workerIndex", "integer")
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("testResults_testId_createdAt_idx")
        .on("testResults")
        .columns(["testId", "createdAt"])
        .execute();
      await db.schema
        .createIndex("testResults_runId_idx")
        .on("testResults")
        .column("runId")
        .execute();
      await db.schema
        .createIndex("testResults_status_createdAt_idx")
        .on("testResults")
        .columns(["status", "createdAt"])
        .execute();
      await db.schema
        .createIndex("testResults_runId_testId_idx")
        .unique()
        .on("testResults")
        .columns(["runId", "testId"])
        .execute();

      const testTags = await db.schema
        .createTable("testTags")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("testResultId", "text", (c) =>
          c.notNull().references("testResults.id").onDelete("cascade"),
        )
        .addColumn("tag", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("testTags_tag_idx")
        .on("testTags")
        .column("tag")
        .execute();
      await db.schema
        .createIndex("testTags_testResultId_idx")
        .on("testTags")
        .column("testResultId")
        .execute();

      const testAnnotations = await db.schema
        .createTable("testAnnotations")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("testResultId", "text", (c) =>
          c.notNull().references("testResults.id").onDelete("cascade"),
        )
        .addColumn("type", "text", (c) => c.notNull())
        .addColumn("description", "text")
        .execute();
      await db.schema
        .createIndex("testAnnotations_testResultId_idx")
        .on("testAnnotations")
        .column("testResultId")
        .execute();

      const testResultAttempts = await db.schema
        .createTable("testResultAttempts")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("testResultId", "text", (c) =>
          c.notNull().references("testResults.id").onDelete("cascade"),
        )
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("durationMs", "integer", (c) => c.notNull())
        .addColumn("errorMessage", "text")
        .addColumn("errorStack", "text")
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("testResultAttempts_testResultId_idx")
        .on("testResultAttempts")
        .column("testResultId")
        .execute();
      await db.schema
        .createIndex("testResultAttempts_testResultId_attempt_uq")
        .unique()
        .on("testResultAttempts")
        .columns(["testResultId", "attempt"])
        .execute();

      const artifacts = await db.schema
        .createTable("artifacts")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("testResultId", "text", (c) =>
          c.notNull().references("testResults.id").onDelete("cascade"),
        )
        .addColumn("type", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("contentType", "text", (c) => c.notNull())
        .addColumn("sizeBytes", "integer", (c) => c.notNull())
        .addColumn("r2Key", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("artifacts_testResultId_idx")
        .on("artifacts")
        .column("testResultId")
        .execute();

      return [
        runs,
        testResults,
        testTags,
        testAnnotations,
        testResultAttempts,
        artifacts,
      ];
    },

    async down(db) {
      await db.schema.dropTable("artifacts").ifExists().execute();
      await db.schema.dropTable("testResultAttempts").ifExists().execute();
      await db.schema.dropTable("testAnnotations").ifExists().execute();
      await db.schema.dropTable("testTags").ifExists().execute();
      await db.schema.dropTable("testResults").ifExists().execute();
      await db.schema.dropTable("runs").ifExists().execute();
    },
  },

  /**
   * Composite indexes leading with `projectId` to back the runs-list filter
   * dropdowns (`SELECT DISTINCT branch / actor / environment WHERE projectId = ?`
   * in `runs-list.tsx:FilterBarLoader`). Without these, the planner falls
   * back to a project-scoped scan plus per-row column read; with them,
   * SQLite skip-scans distinct values from a covering index.
   */
  "0001_runs_filter_indexes": {
    async up(db) {
      await db.schema
        .createIndex("runs_project_branch_idx")
        .on("runs")
        .columns(["projectId", "branch"])
        .execute();
      await db.schema
        .createIndex("runs_project_actor_idx")
        .on("runs")
        .columns(["projectId", "actor"])
        .execute();
      await db.schema
        .createIndex("runs_project_environment_idx")
        .on("runs")
        .columns(["projectId", "environment"])
        .execute();
    },

    async down(db) {
      await db.schema
        .dropIndex("runs_project_environment_idx")
        .ifExists()
        .execute();
      await db.schema.dropIndex("runs_project_actor_idx").ifExists().execute();
      await db.schema.dropIndex("runs_project_branch_idx").ifExists().execute();
    },
  },

  /**
   * Visual regression: when a Playwright snapshot assertion fails, the reporter
   * uploads three image attachments (`*-expected.png`, `*-actual.png`,
   * `*-diff.png`) and labels each with `role` + a shared `snapshotName`. The
   * partial index makes the per-test grouping query (`WHERE testResultId = ?
   * AND attempt = ? AND snapshotName IS NOT NULL`) cheap without bloating the
   * index for non-visual rows.
   */
  "0002_visual_snapshots": {
    async up(db) {
      const addRole = await db.schema
        .alterTable("artifacts")
        .addColumn("role", "text")
        .execute();
      const addSnapshotName = await db.schema
        .alterTable("artifacts")
        .addColumn("snapshotName", "text")
        .execute();
      await db.schema
        .createIndex("artifacts_visual_group_idx")
        .on("artifacts")
        .columns(["testResultId", "attempt", "snapshotName"])
        .where("snapshotName", "is not", null)
        .execute();
      return [addRole, addSnapshotName];
    },

    async down(db) {
      await db.schema
        .dropIndex("artifacts_visual_group_idx")
        .ifExists()
        .execute();
      await db.schema
        .alterTable("artifacts")
        .dropColumn("snapshotName")
        .execute();
      await db.schema.alterTable("artifacts").dropColumn("role").execute();
    },
  },
} satisfies Migrations;
