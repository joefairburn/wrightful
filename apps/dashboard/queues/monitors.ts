import { createMonitorConsumer } from "@/lib/monitors/queue-consumer";

/**
 * The `"monitors"` queue consumer — the system-internal half of synthetic
 * monitoring (the user-facing half is the page actions; the producer is the
 * sweep cron). Each message is one `MonitorJob` (IDs only) the sweep enqueued;
 * the consumer runs the user's check in a container (or the stub) and records
 * its outcome.
 *
 * This file is the THIN ADAPTER — it owns only the Void tuning constants below;
 * the consume-and-decide body is shared via `createMonitorConsumer`
 * (`@/lib/monitors/queue-consumer`), and the ack/retry decision itself lives in
 * the PURE `runMonitorJob` (`@/lib/monitors/executor`). `recordExecutionResult`
 * (wired inside the factory) ALREADY writes both the execution terminal row AND
 * the monitor's `lastStatus`/`lastRunAt` in one atomic batch.
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

export default createMonitorConsumer({
  label: "monitor",
  retryDelaySeconds: retryDelay,
});
