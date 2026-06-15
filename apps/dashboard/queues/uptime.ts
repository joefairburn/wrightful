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
 * The `"uptime"` queue consumer — the system-internal half of HTTP (uptime)
 * monitoring, the lightweight sibling of `queues/monitors.ts`. The sweep cron
 * routes `type === 'http'` jobs here (browser jobs go to `monitors`); each
 * message runs the user's check as a plain `fetch` (no container) and records
 * its outcome.
 *
 * Why a DEDICATED queue rather than sharing `monitors`: that queue is tuned for
 * container jobs (`maxBatchSize = 1`, because one browser job can hold a
 * container for minutes). HTTP checks finish in <=~30s and benefit from
 * batching — coupling them to the container-tuned settings would either starve
 * throughput or risk head-of-line blocking. Tuning each queue independently is
 * why they're split.
 *
 * Like `monitors.ts` this is the THIN ADAPTER: the ack/retry decision lives in
 * the pure `runMonitorJob`, with the same `monitors-repo` IO injected. The
 * executor is the same TYPE-DISPATCHING `resolveExecutor` — for an http job it
 * resolves to `HttpExecutor` regardless of `WRIGHTFUL_MONITOR_EXECUTOR` (which
 * only selects the BROWSER stub/sandbox), so http checks run with real `fetch`
 * in every environment.
 */

/**
 * Batch up to 10 http checks per consumer invocation to amortize invocation
 * overhead at sub-minute volumes. Jobs run SERIALLY within an invocation; an
 * http attempt is hard-capped at ~30s, so a full batch stays well under the
 * queue consumer's 15-minute invocation bound.
 */
export const maxBatchSize = 10;

/**
 * Retry an infra-failed job at most twice (3 deliveries total) before the
 * platform dead-letters it. A genuine site-down result is a `fail` that is
 * ACK'd, never retried — only true infra errors (e.g. a transient DB failure
 * recording the result) reach a retry; the next scheduled tick mints a fresh
 * execution regardless, so a broken check self-heals into a stream of recorded
 * results rather than a stuck queue.
 */
export const maxRetries = 2;

/**
 * Seconds between redeliveries. HTTP infra errors are transient
 * transport/DB blips; a short 5s delay gives a moment of breathing room without
 * the 30s a container-capacity denial wants (the only thing an http retry waits
 * on is a quick DB/runtime hiccup clearing).
 */
export const retryDelay = 5;

export default defineQueue<MonitorJob>(async (batch) => {
  const executor = resolveExecutor(env.WRIGHTFUL_MONITOR_EXECUTOR);
  const deps = {
    loadMonitor: loadMonitorById,
    loadExecution: loadExecutionById,
    claim: claimExecution,
    recordResult: recordExecutionResult,
    executor,
    now: () => Math.floor(Date.now() / 1000),
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
      // `runMonitorJob` converts executor throws into a recorded error result;
      // reaching here means an UNEXPECTED throw (e.g. a recordResult DB
      // failure), so retry the delivery and surface it to Cloudflare Tail.
      logger.error("uptime job failed unexpectedly", {
        monitorId: message.body.monitorId,
        executionId: message.body.executionId,
        attempts: message.attempts,
        message: err instanceof Error ? err.message : String(err),
      });
      message.retry({ delaySeconds: retryDelay });
    }
  }
});
