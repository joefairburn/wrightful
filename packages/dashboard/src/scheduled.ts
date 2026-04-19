import { and, eq, lt, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { runs } from "@/db/schema";
import { readIntVar } from "@/lib/env-parse";

const DEFAULT_STALE_MINUTES = 30;

/**
 * Cron-triggered watchdog: finalizes runs stuck at status='running' that have
 * outlived the configured stale threshold. Handles two scenarios the client
 * can't recover from on its own:
 *
 *   1. Reporter's onEnd /complete call failed after retries.
 *   2. CI process was SIGKILL'd (cancel button, OOM, infra teardown) so
 *      onEnd never fired.
 *
 * Stuck runs are marked 'interrupted' — matching Playwright's FullResult
 * status vocabulary — so they're visibly distinct from tests that failed
 * cleanly. completedAt is set to the sweep time.
 *
 * Schedule is configured in wrangler.jsonc under `triggers.crons`
 * (every 5 minutes). Threshold is env-overridable via
 * WRIGHTFUL_RUN_STALE_MINUTES.
 */
export async function sweepStuckRuns(now = new Date()): Promise<number> {
  const staleMinutes = readIntVar(
    env.WRIGHTFUL_RUN_STALE_MINUTES ?? "",
    DEFAULT_STALE_MINUTES,
  );
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);

  const db = getDb();
  // RETURNING tells us which rows we actually swept so we can log them —
  // useful when diagnosing "why did my run get marked interrupted?" from
  // Workers logs after the fact.
  const swept = await db
    .update(runs)
    .set({ status: "interrupted", completedAt: now })
    .where(and(eq(runs.status, "running"), lt(runs.createdAt, cutoff)))
    .returning({ id: runs.id, createdAt: runs.createdAt });

  for (const row of swept) {
    console.log(
      JSON.stringify({
        event: "watchdog.run_interrupted",
        runId: row.id,
        createdAt: row.createdAt,
        staleMinutes,
      }),
    );
  }
  return swept.length;
}

export async function scheduledHandler(
  _controller: ScheduledController,
  _env: unknown,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    sweepStuckRuns().then(
      (count) => {
        if (count > 0) {
          console.log(
            JSON.stringify({ event: "watchdog.sweep_complete", count }),
          );
        }
      },
      (err: unknown) => {
        // Log but don't throw — Cron Triggers retry failed invocations, and
        // a transient D1 hiccup shouldn't fire alerts until it repeats.
        console.error(
          JSON.stringify({
            event: "watchdog.sweep_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      },
    ),
  );
}

// Drizzle's sql helper kept here for reference / imported elsewhere.
export { sql };
