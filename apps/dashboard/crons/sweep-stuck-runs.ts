import { defineScheduled } from "void";
import { and, db, eq, lt } from "void/db";
import { env } from "void/env";
import { runs } from "@schema";

/**
 * Watchdog: every 5 minutes, mark runs stuck at status='running' longer
 * than `WRIGHTFUL_RUN_STALE_MINUTES` as 'interrupted'.
 *
 * Used to be a fan-out: one RPC per active team gated on
 * `teams.lastActivityAt` to skip idle teams. With a single D1 we just run
 * one UPDATE — the indexed scan over `runs.status` stays cheap.
 */
export const cron = "*/5 * * * *";

export default defineScheduled(async () => {
  const staleMinutes = env.WRIGHTFUL_RUN_STALE_MINUTES;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - staleMinutes * 60;
  await db
    .update(runs)
    .set({ status: "interrupted", completedAt: nowSeconds })
    .where(and(eq(runs.status, "running"), lt(runs.createdAt, cutoff)));
});
