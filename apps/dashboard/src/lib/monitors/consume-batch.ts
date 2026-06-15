import type { RunMonitorJobOutcome } from "@/lib/monitors/executor";
import type { MonitorJob } from "@/lib/monitors/types";

/**
 * The minimal slice of a Void queue `Message` the consume loop touches — its
 * `body` (a {@link MonitorJob}), the `attempts` count (for the error log), and
 * the terminal `ack()` / `retry()` controls. Declared structurally (rather than
 * importing the Void `Message` type) so this module stays free of any `void/*`
 * runtime import and is unit-testable with plain-object fakes.
 */
export interface MonitorQueueMessage {
  body: MonitorJob;
  attempts: number;
  ack(): void;
  retry(opts: { delaySeconds: number }): void;
}

export interface ConsumeMonitorBatchDeps {
  /** Run one job — wired to the pure `runMonitorJob` in the queue adapter. */
  runJob: (body: MonitorJob) => Promise<RunMonitorJobOutcome>;
  /** `delaySeconds` for every redelivery (both the ack/retry path and the catch). */
  retryDelaySeconds: number;
  /**
   * Report an UNEXPECTED throw (NOT the normal infra-error → retry path, which
   * `runJob` already settles internally). Wired to `logger.error` in the
   * adapter; injected here so the catch path is assertable without `void/log`.
   */
  onUnexpectedError: (info: {
    monitorId: string;
    executionId: string;
    attempts: number;
    message: string;
  }) => void;
}

/**
 * The shared monitor queue-consumer loop, lifted out of the two byte-identical
 * `queues/monitors.ts` / `queues/uptime.ts` bodies. For each message: run the
 * job, then `ack` a settled outcome or `retry` an infra outcome; an UNEXPECTED
 * throw (e.g. a `recordResult` DB failure that `runJob` couldn't settle) is
 * reported and retried, never acked — so a transient failure can't silently
 * drop a job. Pure but for its injected deps, so the ack/retry/catch wiring —
 * untested-in-duplicate before — is a single unit-test surface.
 */
export async function consumeMonitorBatch(
  messages: Iterable<MonitorQueueMessage>,
  deps: ConsumeMonitorBatchDeps,
): Promise<void> {
  for (const message of messages) {
    try {
      const { action } = await deps.runJob(message.body);
      if (action === "retry") {
        message.retry({ delaySeconds: deps.retryDelaySeconds });
      } else {
        message.ack();
      }
    } catch (err) {
      deps.onUnexpectedError({
        monitorId: message.body.monitorId,
        executionId: message.body.executionId,
        attempts: message.attempts,
        message: err instanceof Error ? err.message : String(err),
      });
      message.retry({ delaySeconds: deps.retryDelaySeconds });
    }
  }
}
