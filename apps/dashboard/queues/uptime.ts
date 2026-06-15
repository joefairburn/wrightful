import { createMonitorConsumer } from "@/lib/monitors/queue-consumer";

/**
 * The `"uptime"` queue consumer — the system-internal half of the lightweight
 * uptime monitoring family (`http`, plus `tcp`/`ping`), the sibling of
 * `queues/monitors.ts`. The sweep cron routes those types here (browser jobs go
 * to `monitors`); each message runs the user's check WITHOUT a container — an
 * http check as a plain `fetch`, a tcp/ping check as a raw `connect()` socket —
 * and records its outcome.
 *
 * Why a DEDICATED queue rather than sharing `monitors`: that queue is tuned for
 * container jobs (`maxBatchSize = 1`, because one browser job can hold a
 * container for minutes). Uptime checks finish in <=~30s and benefit from
 * batching — coupling them to the container-tuned settings would either starve
 * throughput or risk head-of-line blocking. Tuning each queue independently is
 * why they're split.
 *
 * Like `monitors.ts` this is the THIN ADAPTER — only the tuning consts below are
 * its own; the consume body is shared via `createMonitorConsumer` and the
 * ack/retry decision lives in the pure `runMonitorJob`. The type-dispatching
 * `resolveExecutor` (wired in the factory) resolves an http job to `HttpExecutor`
 * and a tcp/ping job to `TcpExecutor` regardless of `WRIGHTFUL_MONITOR_EXECUTOR`
 * (which only selects the BROWSER stub/sandbox).
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

export default createMonitorConsumer({
  label: "uptime",
  retryDelaySeconds: retryDelay,
});
