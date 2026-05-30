import { defineScheduled } from "void";
import { and, db, eq, lt } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { runs } from "@schema";
import { finalizeStaleRun } from "@/lib/ingest";

/**
 * Watchdog: every 5 minutes, finalize runs stuck at status='running' longer
 * than `WRIGHTFUL_RUN_STALE_MINUTES` (e.g. the CI job was SIGKILL'd and never
 * called /complete).
 *
 * Each stale run is finalized through `finalizeStaleRun` — the same
 * reconcile-and-broadcast path `completeRun` uses — rather than a blanket
 * status UPDATE. That matters because a SIGKILL'd run is exactly the case where
 * the incremental aggregate deltas are most likely to have drifted: we recompute
 * counts from the testResults rows actually present and emit a terminal live
 * event so any dashboard viewer stops spinning on "running".
 */
export const cron = "*/5 * * * *";

export default defineScheduled(async () => {
  const staleMinutes = env.WRIGHTFUL_RUN_STALE_MINUTES;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - staleMinutes * 60;

  const stale = await db
    .select({ id: runs.id, projectId: runs.projectId, teamId: runs.teamId })
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.createdAt, cutoff)));

  let finalized = 0;
  for (const run of stale) {
    try {
      await finalizeStaleRun(run, nowSeconds);
      finalized++;
    } catch (err) {
      logger.error("failed to finalize stale run", {
        runId: run.id,
        projectId: run.projectId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (stale.length > 0) {
    logger.info("swept stuck runs", { found: stale.length, finalized });
  }
});
