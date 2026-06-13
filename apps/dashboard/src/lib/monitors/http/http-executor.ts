import { env } from "void/env";
import {
  HTTP_HARD_TIMEOUT_MS,
  runHttpCheck,
} from "@/lib/monitors/http/http-run";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  MonitorExecutor,
} from "@/lib/monitors/types";

/**
 * The `http` (uptime) `MonitorExecutor` — the THIN ADAPTER over the pure
 * {@link runHttpCheck}. It owns only the wiring of the real runtime to that
 * function's injected deps: the platform `fetch`, the env-derived body cap, the
 * fixed hard timeout, and the clock. All the check LOGIC (timing, capped body
 * read, availability/assertion/threshold state machine) lives in the pure module
 * so it is unit-testable with an injected fetch.
 *
 * Unlike the browser executors there is NO stub variant: a plain `fetch` works
 * identically in dev, e2e, and prod (no Docker / container), so this single
 * class serves every environment.
 */
export class HttpExecutor implements MonitorExecutor {
  execute(input: {
    monitor: Monitor;
    execution: MonitorExecution;
  }): Promise<ExecutionResult> {
    return runHttpCheck(input, {
      // Bind a fresh closure so a test can inject its own fetch in the pure fn.
      fetchImpl: (url, init) => fetch(url, init),
      now: () => Date.now(),
      maxBodyBytes: env.WRIGHTFUL_HTTP_CHECK_MAX_BODY_BYTES,
      hardTimeoutMs: HTTP_HARD_TIMEOUT_MS,
      makeSignal: () => AbortSignal.timeout(HTTP_HARD_TIMEOUT_MS),
    });
  }
}
