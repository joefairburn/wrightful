import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { ulid } from "ulid";
import { sql } from "kysely";
import { type TenantDO } from "@/tenant";
import { getTenantDb } from "@/tenant/internal";
import { freshTeamId } from "./helpers/tenant";

/**
 * Integration tests for the tenant DO's rwsdk/db migration runner and the
 * handful of custom RPC methods on `TenantDO`. Each test takes a fresh
 * `teamId` so the DO it hits is a pristine SQLite instance.
 */

interface SqliteTableRow {
  name: string;
}

interface SqliteIndexRow {
  name: string;
}

describe("tenant DO migrations", () => {
  it("creates every expected table on first touch", async () => {
    const teamId = freshTeamId();
    const db = getTenantDb(teamId);

    // Any query triggers `createDb()`'s lazy `initialize()` which runs the
    // migrations. A no-op SELECT against `runs` is enough.
    const empty = await db.selectFrom("runs").selectAll().execute();
    expect(empty).toEqual([]);

    const rows = await sql<SqliteTableRow>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `.execute(db);
    const tableNames = rows.rows.map((r) => r.name);

    for (const expected of [
      "runs",
      "testResults",
      "testTags",
      "testAnnotations",
      "testResultAttempts",
      "artifacts",
    ]) {
      expect(tableNames).toContain(expected);
    }
  });

  it("creates the expected indexes", async () => {
    const teamId = freshTeamId();
    const db = getTenantDb(teamId);
    // Warm the DO so migrations run.
    await db.selectFrom("runs").selectAll().limit(1).execute();

    const rows = await sql<SqliteIndexRow>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `.execute(db);
    const indexNames = new Set(rows.rows.map((r) => r.name));

    for (const expected of [
      "runs_project_idempotency_key_idx",
      "runs_ci_build_id_idx",
      "runs_branch_created_at_idx",
      "runs_environment_created_at_idx",
      "runs_project_created_at_idx",
      "testResults_testId_createdAt_idx",
      "testResults_runId_idx",
      "testResults_status_createdAt_idx",
      "testResults_runId_testId_idx",
      "testTags_tag_idx",
      "testTags_testResultId_idx",
      "testAnnotations_testResultId_idx",
      "testResultAttempts_testResultId_idx",
      "testResultAttempts_testResultId_attempt_uq",
      "artifacts_testResultId_idx",
    ]) {
      expect(indexNames.has(expected)).toBe(true);
    }
  });

  it("accepts an insert + select round-trip for a full run + test result", async () => {
    const teamId = freshTeamId();
    const db = getTenantDb(teamId);
    const runId = ulid();
    const testResultId = ulid();
    const nowSeconds = Math.floor(Date.now() / 1000);

    await db
      .insertInto("runs")
      .values({
        id: runId,
        projectId: "proj_1",
        idempotencyKey: "idem-1",
        ciProvider: null,
        ciBuildId: null,
        branch: "main",
        environment: null,
        commitSha: null,
        commitMessage: null,
        prNumber: null,
        repo: null,
        actor: null,
        totalTests: 1,
        expectedTotalTests: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 42,
        status: "passed",
        reporterVersion: null,
        playwrightVersion: null,
        createdAt: nowSeconds,
        completedAt: nowSeconds,
        committed: 1,
      })
      .execute();

    await db
      .insertInto("testResults")
      .values({
        id: testResultId,
        runId,
        testId: "tests/example.spec.ts|passing",
        title: "passing",
        file: "tests/example.spec.ts",
        projectName: null,
        status: "passed",
        durationMs: 42,
        retryCount: 0,
        errorMessage: null,
        errorStack: null,
        workerIndex: 0,
        createdAt: nowSeconds,
      })
      .execute();

    const runBack = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(runBack.status).toBe("passed");
    expect(runBack.branch).toBe("main");
    expect(runBack.committed).toBe(1);

    const testBack = await db
      .selectFrom("testResults")
      .selectAll()
      .where("id", "=", testResultId)
      .executeTakeFirstOrThrow();
    expect(testBack.runId).toBe(runId);
    expect(testBack.status).toBe("passed");
  });
});

describe("TenantDO.batchExecute", () => {
  it("rolls back the whole batch when any statement throws", async () => {
    const teamId = freshTeamId();
    const db = getTenantDb(teamId);
    // Ensure migrations have run.
    await db.selectFrom("runs").selectAll().limit(1).execute();

    const runId = ulid();
    const insertValues = {
      id: runId,
      projectId: "proj_1",
      idempotencyKey: null,
      ciProvider: null,
      ciBuildId: null,
      branch: null,
      environment: null,
      commitSha: null,
      commitMessage: null,
      prNumber: null,
      repo: null,
      actor: null,
      totalTests: 0,
      expectedTotalTests: null,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 0,
      status: "running",
      reporterVersion: null,
      playwrightVersion: null,
      createdAt: Math.floor(Date.now() / 1000),
      completedAt: null,
      committed: 1,
    };

    const first = db.insertInto("runs").values(insertValues).compile();
    // Second statement reuses the same id → PRIMARY KEY violation.
    const duplicate = db.insertInto("runs").values(insertValues).compile();

    // Run the transaction in-process via `runInDurableObject` so the
    // constraint throw stays inside the DO callback — going through the
    // RPC boundary surfaces it as an unhandled-in-promise log in workerd
    // even though our caller observes the rejection normally.
    const stub = env.TENANT.get(env.TENANT.idFromName(teamId));
    const threw = await runInDurableObject(
      stub,
      async (instance: TenantDO, state: DurableObjectState) => {
        await instance.initialize();
        try {
          state.storage.transactionSync(() => {
            state.storage.sql.exec(first.sql, ...first.parameters).toArray();
            state.storage.sql
              .exec(duplicate.sql, ...duplicate.parameters)
              .toArray();
          });
          return false;
        } catch {
          return true;
        }
      },
    );
    expect(threw).toBe(true);

    // Atomic rollback: neither insert committed.
    const rows = await db
      .selectFrom("runs")
      .select("id")
      .where("id", "=", runId)
      .execute();
    expect(rows).toEqual([]);
  });
});

describe("TenantDO.sweepStuckRuns", () => {
  it("flips stale running runs to interrupted and leaves the rest alone", async () => {
    const teamId = freshTeamId();
    const db = getTenantDb(teamId);
    const stub = env.TENANT.get(env.TENANT.idFromName(teamId));

    const staleCreatedAt = 1_000_000; // unix seconds, well before `now`
    const freshCreatedAt = 2_000_000;
    const cutoffSeconds = 1_500_000;
    const nowSeconds = 2_100_000;

    const baseValues = {
      projectId: "proj_1",
      idempotencyKey: null,
      ciProvider: null,
      ciBuildId: null,
      branch: null,
      environment: null,
      commitSha: null,
      commitMessage: null,
      prNumber: null,
      repo: null,
      actor: null,
      totalTests: 0,
      expectedTotalTests: null,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      durationMs: 0,
      reporterVersion: null,
      playwrightVersion: null,
      completedAt: null,
      committed: 1,
    };

    const staleA = ulid();
    const staleB = ulid();
    const freshRunning = ulid();
    const alreadyDone = ulid();

    await db
      .insertInto("runs")
      .values([
        {
          ...baseValues,
          id: staleA,
          status: "running",
          createdAt: staleCreatedAt,
        },
        {
          ...baseValues,
          id: staleB,
          status: "running",
          createdAt: staleCreatedAt,
        },
        {
          ...baseValues,
          id: freshRunning,
          status: "running",
          createdAt: freshCreatedAt,
        },
        {
          ...baseValues,
          id: alreadyDone,
          status: "passed",
          createdAt: staleCreatedAt,
          completedAt: staleCreatedAt,
        },
      ])
      .execute();

    const swept: Array<{ id: string; createdAt: number }> =
      await stub.sweepStuckRuns(cutoffSeconds, nowSeconds);
    const sweptIds = swept.map((r) => r.id).sort();
    expect(sweptIds).toEqual([staleA, staleB].sort());

    // Confirm the post-conditions in persistent state.
    const rows = await db
      .selectFrom("runs")
      .select(["id", "status", "completedAt"])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(staleA)?.status).toBe("interrupted");
    expect(byId.get(staleA)?.completedAt).toBe(nowSeconds);
    expect(byId.get(staleB)?.status).toBe("interrupted");
    expect(byId.get(freshRunning)?.status).toBe("running");
    expect(byId.get(alreadyDone)?.status).toBe("passed");
  });

  it("is a no-op when there are no stuck runs", async () => {
    const teamId = freshTeamId();
    const stub = env.TENANT.get(env.TENANT.idFromName(teamId));

    const swept = await stub.sweepStuckRuns(1_000_000, 2_000_000);
    expect(swept).toEqual([]);
  });
});
