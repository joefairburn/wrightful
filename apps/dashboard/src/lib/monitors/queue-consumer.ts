import { defineQueue } from "void";
import { env } from "void/env";
import { logger } from "void/log";
import { maybeSendMonitorAlert } from "@/lib/monitors/alerts";
import { consumeMonitorBatch } from "@/lib/monitors/consume-batch";
import { runMonitorJob } from "@/lib/monitors/executor";
import { resolveExecutor } from "@/lib/monitors/executor-registry";
import {
  claimExecution,
  loadExecutionById,
  loadMonitorById,
  recordExecutionResult,
} from "@/lib/monitors/monitors-repo";
import type { MonitorJob } from "@/lib/monitors/types";
import { broadcastProjectRoom } from "@/realtime/publish";

/**
 * Build a monitor queue consumer. The two queue files (`queues/monitors.ts`,
 * `queues/uptime.ts`) used to carry byte-identical bodies (same `resolveExecutor`
 * + `deps` wiring + per-message ack/retry/catch loop) differing only in their
 * tuning constants and the log label; that body now lives here once, behind a
 * tiny interface (`label` + `retryDelaySeconds`), with the per-message loop
 * itself in the pure {@link consumeMonitorBatch}.
 *
 * Each queue file keeps ONLY its Void tuning consts
 * (`maxBatchSize`/`maxRetries`/`retryDelay`, which Void's scanner reads from the
 * source text, not by evaluation) and `export default createMonitorConsumer(…)`.
 *
 * The injected IO is identical for both queues: the `monitors-repo`
 * system-internal load/claim/record functions (scoped by each row's own
 * projectId), the type-dispatching `resolveExecutor`, a `Date.now`-based clock,
 * and the non-fatal project-room broadcast.
 */
export function createMonitorConsumer(opts: {
  label: string;
  retryDelaySeconds: number;
}) {
  return defineQueue<MonitorJob>(async (batch) => {
    const executor = resolveExecutor(env.WRIGHTFUL_MONITOR_EXECUTOR);
    const deps = {
      loadMonitor: loadMonitorById,
      loadExecution: loadExecutionById,
      claim: claimExecution,
      recordResult: recordExecutionResult,
      executor,
      now: () => Math.floor(Date.now() / 1000),
      // Settle events to the project room drive the live monitors list. Same
      // DO-to-DO publish path the ingest pipeline uses; non-fatal by design.
      broadcast: broadcastProjectRoom,
      // Email the team on a healthy↔down transition. Edge-triggered + best-effort
      // (self-catching); a no-op when email isn't configured.
      alert: maybeSendMonitorAlert,
    };

    await consumeMonitorBatch(batch.messages, {
      runJob: (body) => runMonitorJob(body, deps),
      retryDelaySeconds: opts.retryDelaySeconds,
      onUnexpectedError: (info) =>
        // `runMonitorJob` already converts executor throws into a recorded error
        // result; reaching here means an UNEXPECTED throw (e.g. a recordResult
        // DB failure), surfaced to Cloudflare Tail.
        logger.error(`${opts.label} job failed unexpectedly`, info),
    });
  });
}
