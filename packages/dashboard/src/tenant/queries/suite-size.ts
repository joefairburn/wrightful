import { getTenantDb } from "../internal";
import type { TenantScope } from "../index";

/**
 * Count tests whose first-ever occurrence in the project falls within
 * the supplied lookback. Backs the "Tests Added (Nd)" KPI on the suite
 * size analytics page. The aggregation is `MIN(createdAt) GROUP BY
 * testId` filtered to that minimum landing in-window, so a test that's
 * been around for months but happened to run again in the lookback
 * doesn't count as "added".
 */
export async function loadTestsAddedCount(
  scope: TenantScope,
  windowStartSec: number,
): Promise<number> {
  const db = getTenantDb(scope.teamId);
  const projectId = scope.projectId as string;
  const row = await db
    .selectFrom(
      db
        .selectFrom("testResults")
        .where("projectId", "=", projectId)
        .select([
          "testResults.testId as testId",
          (eb) => eb.fn.min("testResults.createdAt").as("firstSeen"),
        ])
        .groupBy("testResults.testId")
        .as("firsts"),
    )
    .select((eb) => eb.fn.countAll<number>().as("added"))
    .where("firstSeen", ">=", windowStartSec)
    .executeTakeFirst();
  return row?.added ?? 0;
}
