import { defineQueue } from "void";
import { env } from "void/env";
import { logger } from "void/log";
import { maybeSendMonitorAlert } from "@/lib/monitors/alerts";
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
 * The `"monitors"` queue consumer — the system-internal half of synthetic
 * monitoring (the user-facing half is the page actions; the producer is the
 * sweep cron). Each message is one `MonitorJob` (IDs only) the sweep enqueued;
 * the consumer runs the user's check in a container (or the stub) and records
 * its outcome.
 *
 * This file is the THIN ADAPTER — it owns only the wiring, not the logic. The
 * ack/retry decision lives in the PURE `runMonitorJob` (`@/lib/monitors/executor`)
 * with its IO injected: the `monitors-repo` system-internal functions
 * (load/claim/record by id, scoped by the row's own projectId — like
 * `finalizeStaleRun`), the executor resolved from `WRIGHTFUL_MONITOR_EXECUTOR`,
 * and a `Date.now`-based clock. Keeping the decision pure is what lets it be
 * unit-tested without the `void/*` runtime the harness can't resolve.
 *
 * `recordExecutionResult` ALREADY writes both the execution terminal row AND the
 * monitor's `lastStatus`/`lastRunAt` in one atomic batch, so the consumer does
 * NOT touch the monitor row separately — it just hands `recordResult` through.
 */

/**
 * One job per delivery. Jobs run SERIALLY inside a consumer invocation and each
 * may hold a container for up to `WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS`
 * (default 5 min) — a batch of N multiplies that wall-clock, and anything above
 * ~3 would push a full batch past the queue consumer's 15-minute invocation
 * bound, killing later messages through no fault of their own. Per-invocation
 * concurrency comes from Cloudflare scaling consumer invocations, not from
 * batching.
 */
export const maxBatchSize = 1;

/**
 * Retry an infra-failed job at most twice (3 deliveries total) before the
 * platform dead-letters it. A monitor that can't run after 3 tries within the
 * interval is better surfaced as the recorded `error` state (which
 * `runMonitorJob` already persisted on each attempt) than retried forever; the
 * NEXT scheduled tick mints a fresh execution anyway, so a permanently-broken
 * monitor self-heals into a steady stream of `error` executions rather than a
 * stuck queue.
 */
export const maxRetries = 2;

/**
 * Seconds between redeliveries — both the consumer-level default and the
 * explicit `delaySeconds` passed to every `message.retry()` below. Infra
 * errors here are capacity denials (`SandboxLimitError`) or transient
 * transport/DB failures; with the platform default of 0 a redelivery lands
 * milliseconds later against the same exhausted budget, burning all
 * `maxRetries` within seconds and dead-lettering a job a moment of breathing
 * room would have saved.
 */
export const retryDelay = 30;

export default defineQueue<MonitorJob>(async (batch) => {
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

  for (const message of batch.messages) {
    try {
      const { action } = await runMonitorJob(message.body, deps);
      if (action === "retry") {
        message.retry({ delaySeconds: retryDelay });
      } else {
        message.ack();
      }
    } catch (err) {
      // `runMonitorJob` already converts executor throws into a recorded error
      // result; reaching here means an UNEXPECTED throw (e.g. a recordResult DB
      // failure), so retry the delivery and surface it to Cloudflare Tail.
      logger.error("monitor job failed unexpectedly", {
        monitorId: message.body.monitorId,
        executionId: message.body.executionId,
        attempts: message.attempts,
        message: err instanceof Error ? err.message : String(err),
      });
      message.retry({ delaySeconds: retryDelay });
    }
  }
});
