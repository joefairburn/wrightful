import { queues } from "void/queues";
import type { Monitor } from "@schema";
import type { MonitorJob } from "@/lib/monitors/types";

/**
 * Route one monitor job to its queue by the monitor's type — the SINGLE source
 * of the producer-side routing, shared by the scheduler cron
 * (`crons/sweep-monitors.ts`) and the on-demand "run now" action
 * (`pages/t/[teamSlug]/p/[projectSlug]/monitors/[monitorId]/index.server.ts`) so
 * the two can't drift. The lightweight uptime family (`http`, plus `tcp`/`ping` —
 * a raw socket connect, batched) goes to the `uptime` queue; browser jobs to the
 * container-tuned `monitors` queue (one Void Sandbox container per job). The job
 * body itself stays IDs-only either way (see {@link MonitorJob}); the caller
 * already holds the monitor row, so the type-routing is free.
 */
export async function enqueueMonitorJob(
  job: MonitorJob,
  monitor: Monitor,
): Promise<void> {
  if (
    monitor.type === "http" ||
    monitor.type === "tcp" ||
    monitor.type === "ping"
  ) {
    await queues.uptime.send(job);
  } else {
    await queues.monitors.send(job);
  }
}
