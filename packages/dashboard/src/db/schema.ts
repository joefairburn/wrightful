import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key"),
    ciProvider: text("ci_provider"),
    ciBuildId: text("ci_build_id"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    prNumber: integer("pr_number"),
    repo: text("repo"),
    shardIndex: integer("shard_index"),
    shardTotal: integer("shard_total"),
    totalTests: integer("total_tests").notNull(),
    passed: integer("passed").notNull(),
    failed: integer("failed").notNull(),
    flaky: integer("flaky").notNull(),
    skipped: integer("skipped").notNull(),
    durationMs: integer("duration_ms").notNull(),
    status: text("status").notNull(),
    reporterVersion: text("reporter_version"),
    playwrightVersion: text("playwright_version"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("runs_idempotency_key_idx").on(table.idempotencyKey),
    index("runs_ci_build_id_idx").on(table.ciBuildId),
    index("runs_branch_created_at_idx").on(table.branch, table.createdAt),
    index("runs_repo_created_at_idx").on(table.repo, table.createdAt),
  ],
);

export const testResults = sqliteTable(
  "test_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    testId: text("test_id").notNull(),
    title: text("title").notNull(),
    file: text("file").notNull(),
    projectName: text("project_name"),
    status: text("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    workerIndex: integer("worker_index"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("test_results_test_id_created_at_idx").on(
      table.testId,
      table.createdAt,
    ),
    index("test_results_run_id_idx").on(table.runId),
    index("test_results_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const testTags = sqliteTable(
  "test_tags",
  {
    id: text("id").primaryKey(),
    testResultId: text("test_result_id")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [
    index("test_tags_tag_idx").on(table.tag),
    index("test_tags_test_result_id_idx").on(table.testResultId),
  ],
);

export const testAnnotations = sqliteTable(
  "test_annotations",
  {
    id: text("id").primaryKey(),
    testResultId: text("test_result_id")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    description: text("description"),
  },
  (table) => [
    index("test_annotations_test_result_id_idx").on(table.testResultId),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    testResultId: text("test_result_id")
      .notNull()
      .references(() => testResults.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("artifacts_test_result_id_idx").on(table.testResultId),
  ],
);
