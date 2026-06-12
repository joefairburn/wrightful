import { env } from "void/env";
import { getSandbox, SandboxLimitError } from "void/sandbox";
import {
  findRunByIdempotencyKey,
  tenantScopeForMonitor,
} from "@/lib/monitors/run-linking";
import {
  resolveMonitorPlan,
  sandboxSleepAfter,
} from "@/lib/monitors/sandbox-policy";
import { runSandboxExecution } from "@/lib/monitors/sandbox-run";
import {
  mintSyntheticKey,
  revokeSyntheticKey,
} from "@/lib/monitors/synthetic-key";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  MonitorExecutor,
} from "@/lib/monitors/types";

/**
 * The production `MonitorExecutor` (`WRIGHTFUL_MONITOR_EXECUTOR=sandbox`,
 * default) — the THIN ADAPTER over the pure {@link runSandboxExecution}. It
 * owns only the wiring of the real runtime IO to that function's injected deps:
 * the `void/sandbox` container acquire, the `void/db`-backed key + scope + run
 * helpers, the env-derived wall-clock budget + public URL, the plan-resolved
 * idle timeout, and the clock. All the lifecycle LOGIC — scaffold → exec →
 * resolve → tear down (the `finally` that `destroy()`s the container) and the
 * `infraError` ack/retry classification — lives in the pure module so it is
 * unit-tested (`__tests__/sandbox-run.test.ts`); importing `void/sandbox` here
 * keeps this class integration-only (the harness can't resolve that runtime).
 *
 * The `sleepAfter` is resolved per plan (`sandbox-policy.ts`): it bounds a
 * LEAKED container's idle billing if this Worker is evicted before the
 * `finally` runs — a healthy run is torn down immediately and never reaches it.
 */
export class SandboxExecutor implements MonitorExecutor {
  execute(input: {
    monitor: Monitor;
    execution: MonitorExecution;
  }): Promise<ExecutionResult> {
    return runSandboxExecution(input, {
      getSandbox: (id, options) => getSandbox(id, options),
      mintSyntheticKey,
      revokeSyntheticKey,
      tenantScopeForMonitor,
      findRunByIdempotencyKey,
      classifyLimitError: (err) =>
        err instanceof SandboxLimitError ? { reason: err.reason } : null,
      maxDurationMs: env.WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS * 1000,
      sleepAfter: sandboxSleepAfter(resolveMonitorPlan(input.monitor)),
      publicUrl: env.WRIGHTFUL_PUBLIC_URL,
      now: () => Date.now(),
    });
  }
}
