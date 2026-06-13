import { defineQueue } from "void";
import { env } from "void/env";
import { logger } from "void/log";
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

type MonitorQueueHandler = Parameters<typeof defineQueue<MonitorJob>>[0];

/**
 * Shared consumer body for the two monitor queues (`queues/monitors.ts` and
 * `queues/uptime.ts`). The queues differ ONLY in their tuning exports
 * (`maxBatchSize` / `maxRetries` / `retryDelay`) — Void reads those as module
 * exports, so they must stay in the queue files, each with its own rationale.
 * The wiring below is byte-identical between the two and lives here so the
 * adapters can't drift.
 *
 * NOTE: this module imports the `void/*` runtime, so unit tests must keep
 * exercising the PURE `runMonitorJob` (`@/lib/monitors/executor`) directly,
 * not this wrapper.
 *
 * @param label names the queue in Tail logs ("monitor" / "uptime").
 * @param retryDelay seconds threaded into every `message.retry()` so
 *   redeliveries get breathing room — see each queue file for the per-queue
 *   rationale behind the value.
 */
export function makeMonitorQueueHandler(
  label: string,
  retryDelay: number,
): MonitorQueueHandler {
  return async (batch) => {
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
    };

    for (const message of batch.messages) {
      try {
        const { action } = await runMonitorJob(message.body, deps);
        if (action === "retry") {
          message.retry({ delaySeconds: retryDelay });
        } else {
          message.ack();
        }
      } catch (err) {
        // `runMonitorJob` already converts executor throws into a recorded
        // error result; reaching here means an UNEXPECTED throw (e.g. a
        // recordResult DB failure), so retry the delivery and surface it to
        // Cloudflare Tail.
        logger.error(`${label} job failed unexpectedly`, {
          monitorId: message.body.monitorId,
          executionId: message.body.executionId,
          attempts: message.attempts,
          message: err instanceof Error ? err.message : String(err),
        });
        message.retry({ delaySeconds: retryDelay });
      }
    }
  };
}
