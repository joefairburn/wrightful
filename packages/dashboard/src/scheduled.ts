import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { readIntVar } from "@/lib/env-parse";
import { internalTenantStubForCron } from "@/tenant/internal";

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
 * `WRIGHTFUL_RUN_STALE_MINUTES`.
 *
 * Fan-out: tenant data lives in per-team Durable Objects, so the sweep
 * iterates teams active within the stale window and RPCs each one. Teams
 * idle for longer than the stale threshold cannot have a newly-stuck run,
 * so we can safely skip them via the `teams.lastActivityAt` index.
 */
export async function sweepStuckRuns(now = new Date()): Promise<number> {
  const staleMinutes = readIntVar(
    env.WRIGHTFUL_RUN_STALE_MINUTES ?? "",
    DEFAULT_STALE_MINUTES,
  );
  const cutoffSeconds = Math.floor(
    (now.getTime() - staleMinutes * 60_000) / 1000,
  );
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const controlDb = getDb();
  const activeTeams = await controlDb
    .selectFrom("teams")
    .select("id")
    .where("lastActivityAt", ">=", cutoffSeconds)
    .execute();

  if (activeTeams.length === 0) return 0;

  const perTeam = await Promise.all(
    activeTeams.map(async (team) => {
      try {
        // The watchdog runs without a user / API-key context — it fans
        // out to every team that had recent activity. `internalTenantStubForCron`
        // is the explicit, grep-able escape hatch for exactly this case.
        const stub = internalTenantStubForCron(team.id);
        const swept = await stub.sweepStuckRuns(cutoffSeconds, nowSeconds);
        return { teamId: team.id, swept };
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "watchdog.team_sweep_failed",
            teamId: team.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return { teamId: team.id, swept: [] as Array<never> };
      }
    }),
  );

  let total = 0;
  for (const { teamId, swept } of perTeam) {
    for (const row of swept) {
      console.log(
        JSON.stringify({
          event: "watchdog.run_interrupted",
          teamId,
          runId: row.id,
          createdAt: row.createdAt,
          staleMinutes,
        }),
      );
      total += 1;
    }
  }
  return total;
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
