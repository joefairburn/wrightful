import { connect } from "cloudflare:sockets";
import { runTcpCheck, TCP_HARD_TIMEOUT_MS } from "@/lib/monitors/tcp/tcp-run";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  MonitorExecutor,
} from "@/lib/monitors/types";

/**
 * The `tcp` / `ping` `MonitorExecutor` — the THIN ADAPTER over the pure
 * {@link runTcpCheck}, the raw-socket twin of `HttpExecutor`. It owns only the
 * wiring of the real runtime to that function's injected deps: the platform
 * `connect()` from `cloudflare:sockets`, the fixed hard timeout, the clock, and
 * the timeout-delay timer. All the check LOGIC (the connect/timeout race, the
 * SSRF re-check, the pass/fail state machine) lives in the pure module so it is
 * unit-testable with an injected connect.
 *
 * Like `HttpExecutor` there is NO stub variant: `connect()` works identically in
 * dev, e2e, and prod (no container), so this single class serves every
 * environment. The sweep routes tcp/ping jobs to the `uptime` queue (alongside
 * http), and `resolveExecutor` dispatches `tcp`/`ping` here regardless of
 * `WRIGHTFUL_MONITOR_EXECUTOR` (which only selects the BROWSER stub/sandbox).
 *
 * NOTE: `connect()` is imported from `cloudflare:sockets` — a workerd built-in,
 * resolved at runtime; the type comes from a local ambient declaration
 * (`cloudflare-sockets.d.ts`) since this app's tsconfig `types` is narrowed.
 */
export class TcpExecutor implements MonitorExecutor {
  execute(input: {
    monitor: Monitor;
    execution: MonitorExecution;
  }): Promise<ExecutionResult> {
    return runTcpCheck(input, {
      // Bind a fresh closure so a test can inject its own connect in the pure fn.
      // The real `Socket` (its ambient decl in `cloudflare-sockets.d.ts`) is
      // structurally a `TcpSocketLike` — it has `opened` + `close` — so it's
      // assignable to the minimal surface the pure fn touches, no cast.
      connectImpl: (address) => connect(address),
      now: () => Date.now(),
      hardTimeoutMs: TCP_HARD_TIMEOUT_MS,
      delay: (ms) =>
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), ms),
        ),
    });
  }
}
