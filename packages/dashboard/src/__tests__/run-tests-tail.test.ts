import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  makeTenantTestDb,
  makeTenantScope,
  selectResult,
} from "./helpers/test-db";
import { composeRunTestsTail, TESTS_TAIL_SIZE } from "../routes/api/progress";

function fakeRow(i: number) {
  return {
    id: `tr-${i}`,
    runId: "run-1",
    testId: `t-${i}`,
    title: `Test ${i}`,
    file: "spec.ts",
    projectName: null,
    status: "passed",
    durationMs: 100,
    retryCount: 0,
    errorMessage: null,
    errorStack: null,
    createdAt: 1_700_000_000 + i,
  };
}

describe("composeRunTestsTail", () => {
  it("orders by createdAt DESC, id DESC and limits to TESTS_TAIL_SIZE", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([fakeRow(1), fakeRow(2), fakeRow(3)]));

    await composeRunTestsTail(scope, "run-1");

    expect(driver.queries).toHaveLength(1);
    const q = driver.queries[0];
    expect(q.sql).toMatch(/from\s+"testResults"/i);
    expect(q.sql).toMatch(/order by\s+"createdAt"\s+desc/i);
    expect(q.sql).toMatch(/order by[^]*"id"\s+desc/i);
    expect(q.sql).toMatch(/limit\s+\?/i);
    expect(q.parameters).toContain(TESTS_TAIL_SIZE);
  });

  it("filters by runId", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([]));

    await composeRunTestsTail(scope, "run-xyz");

    const q = driver.queries[0];
    expect(q.parameters).toContain("run-xyz");
  });

  it("returns an empty tests array (with updatedAt) when the run has no rows", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([]));

    const tail = await composeRunTestsTail(scope, "run-1");
    expect(tail.tests).toEqual([]);
    expect(typeof tail.updatedAt).toBe("number");
  });

  it("normalises test row statuses through the union", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(
      selectResult([
        { ...fakeRow(1), status: "passed" },
        { ...fakeRow(2), status: "garbage-status" },
      ]),
    );

    const tail = await composeRunTestsTail(scope, "run-1");
    expect(tail.tests[0].status).toBe("passed");
    expect(tail.tests[1].status).toBe("queued");
  });

  it("does not select createdAt (kept off the wire)", async () => {
    const { db, driver } = makeTenantTestDb();
    const scope = makeTenantScope({ db });
    driver.results.push(selectResult([fakeRow(1)]));

    await composeRunTestsTail(scope, "run-1");
    const q = driver.queries[0];
    expect(q.sql).not.toMatch(
      /"createdAt"\s*,?\s*"runId"|select[^]*"createdAt"\s*,/i,
    );
    // Spot-check one column that should appear:
    expect(q.sql).toMatch(/"errorMessage"/i);
  });
});
