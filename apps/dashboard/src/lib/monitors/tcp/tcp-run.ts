import { parseTcpMonitorConfig } from "@/lib/monitors/monitor-schemas";
import { checkTcpHostPolicy } from "@/lib/monitors/tcp/host-policy";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  TcpResultDetail,
} from "@/lib/monitors/types";

/**
 * The check lifecycle of a `tcp` (and `ping`) monitor as a PURE,
 * dependency-injected function — the raw-socket twin of `runHttpCheck`
 * (`http/http-run.ts`). Every effect it needs (the socket `connect`, the clock,
 * the timeout) is a param on {@link TcpRunDeps}, so it imports NO `void/*` /
 * `cloudflare:*` runtime and is fully unit-testable with an injected connect.
 * `TcpExecutor` (`tcp-executor.ts`) is the thin adapter wiring the real
 * `connect()` from `cloudflare:sockets` + the clock.
 *
 * ── Why "ping" is a TCP connect, not ICMP ───────────────────────────────────
 * Cloudflare Workers CANNOT send ICMP echo (ping) packets — the runtime exposes
 * only `connect()` (TCP, via `cloudflare:sockets`) and `fetch()` for egress.
 * There is no raw-socket / ICMP capability. So a `"ping"` monitor is modelled as
 * the SAME probe a `"tcp"` monitor uses: open a TCP connection to `host:port`
 * and measure how long the handshake takes. "Reachable" therefore means "a TCP
 * connection to this port opens within the timeout" — which is what an uptime
 * check actually cares about (the service is accepting connections), and is
 * strictly more useful than an ICMP echo (a host can answer ping while its
 * service is down). `"tcp"` and `"ping"` share this executor and config 1:1; the
 * only difference is the label the UI shows. (An HTTP-HEAD probe was the other
 * option the plan floats, but that only works for http servers and duplicates
 * the http executor — a raw TCP connect works for ANY port: databases, SMTP,
 * Redis, an SSH bastion, etc.)
 *
 * Outcome model (mirrors `runHttpCheck`):
 *   - **connection opens within the timeout ⇒ `pass`** (connectivity is the only
 *     signal a tcp check has — there is no response body to assert on).
 *   - **connect fails / times out / is refused ⇒ `fail`** — the port being
 *     unreachable is the DOWN signal uptime monitoring exists to catch, NOT
 *     `error`. `infraError: false` so the queue acks it as a real, recorded
 *     result rather than retrying.
 *   - **host blocked by the SSRF policy ⇒ terminal `error`, `infraError: false`**
 *     — defense in depth: the config-write path already rejected a private/
 *     loopback/metadata host, but a directly-written or schema-evolved row is
 *     re-vetted here before any socket opens, so a monitor can NEVER connect to
 *     internal infra. Settled (not retried) — a bad host can't be fixed by
 *     re-running.
 *   - **invalid stored config ⇒ terminal `error`, `infraError: false`** — a bad
 *     direct DB write can't be fixed by retrying, so settle it (don't loop).
 */

/**
 * An {@link ExecutionResult} whose `resultDetail` is precisely a tcp detail
 * (never the http variant of the storage union) — so callers + tests narrow to
 * `TcpResultDetail` fields without a guard. Assignable to `ExecutionResult`. The
 * tcp twin of `HttpExecutionResult`.
 */
export type TcpExecutionResult = Omit<ExecutionResult, "resultDetail"> & {
  resultDetail: TcpResultDetail | null;
};

/** Hard wall-clock cap on a single tcp check, ms. Mirrors `HTTP_HARD_TIMEOUT_MS`. */
export const TCP_HARD_TIMEOUT_MS = 30_000;

/**
 * The minimal `Socket` surface {@link runTcpCheck} touches — a structural subset
 * of `cloudflare:sockets`' `Socket` (the full type isn't in this app's tsconfig
 * `types`, and the pure module must not pull a `cloudflare:*` import anyway). The
 * real socket satisfies this; a test passes a fake.
 */
export interface TcpSocketLike {
  /** Resolves once the TCP connection has opened (handshake complete). */
  readonly opened: Promise<unknown>;
  /** Close the socket, releasing the connection. */
  close(): Promise<void>;
}

/** Open a TCP connection to `host:port`. The injectable `connect()` shape. */
export type TcpConnectFn = (address: {
  hostname: string;
  port: number;
}) => TcpSocketLike;

/** Injected effects + limits for {@link runTcpCheck}. */
export interface TcpRunDeps {
  /** Open a socket — the real `connect` in prod, a spy under test. */
  connectImpl: TcpConnectFn;
  /** Epoch milliseconds. */
  now: () => number;
  /** Hard wall-clock cap for the whole check, ms (the timeout-message bound). */
  hardTimeoutMs: number;
  /**
   * Resolve after `ms` to a sentinel — the timeout arm of the connect race.
   * Injected (instead of a bare `setTimeout`) so a test can fire it synchronously
   * without a real timer, the way `http-run` injects `makeSignal`.
   */
  delay: (ms: number) => Promise<"timeout">;
}

/** Settle an invalid-config / blocked-host monitor terminally (never retried). */
function configError(message: string, durationMs: number): TcpExecutionResult {
  return {
    state: "error",
    runId: null,
    durationMs,
    errorMessage: message,
    infraError: false,
    statusCode: null,
    resultDetail: null,
  };
}

/**
 * Run one tcp check to an {@link ExecutionResult}. See the module docstring for
 * the outcome model and the ICMP/ping rationale. Pure: all IO is via
 * {@link TcpRunDeps}.
 */
export async function runTcpCheck(
  input: { monitor: Monitor; execution: MonitorExecution },
  deps: TcpRunDeps,
): Promise<TcpExecutionResult> {
  const startedAt = deps.now();
  const config = parseTcpMonitorConfig(input.monitor.config);
  if (!config) {
    return configError(
      "monitor has no valid tcp config",
      deps.now() - startedAt,
    );
  }

  // SSRF re-check on the READ path — belt-and-braces over the config-write
  // refinement. A directly-written / schema-evolved row could carry a private/
  // loopback/metadata host; refuse to open a socket to it. Terminal `error`
  // (not `fail`): a blocked host is a misconfiguration, not a DOWN service.
  const hostCheck = checkTcpHostPolicy(config.host);
  if (!hostCheck.ok) {
    return configError(
      `host is not allowed: ${hostCheck.reason}`,
      deps.now() - startedAt,
    );
  }

  // The effective timeout is the config's connectTimeout, hard-clamped to the
  // wall-clock cap so a stored config can't ask for longer than the platform cap.
  const timeoutMs = Math.min(config.connectTimeoutMs, deps.hardTimeoutMs);

  let socket: TcpSocketLike;
  try {
    socket = deps.connectImpl({ hostname: config.host, port: config.port });
  } catch (err) {
    // `connect()` itself threw synchronously (e.g. the runtime refused the
    // address) — a DOWN signal, recorded as `fail`, acked (`infraError: false`).
    const totalMs = deps.now() - startedAt;
    return failResult(
      config.host,
      config.port,
      `connection failed: ${err instanceof Error ? err.message : String(err)}`,
      totalMs,
    );
  }

  // Race the connection opening against the timeout. The connection promise wins
  // → the socket opened (pass); the delay wins → timed out (fail). Either way we
  // close the socket so a half-open connection can't leak.
  try {
    const outcome = await Promise.race([
      socket.opened.then(() => "opened" as const),
      deps.delay(timeoutMs),
    ]);
    const connectMs = deps.now() - startedAt;

    if (outcome === "timeout") {
      await closeQuietly(socket);
      const totalMs = deps.now() - startedAt;
      return failResult(
        config.host,
        config.port,
        `connection timed out after ${timeoutMs}ms`,
        totalMs,
      );
    }

    // Connection opened — the port is up. Close it (we only needed to know it
    // accepts connections) and settle `pass`.
    await closeQuietly(socket);
    const totalMs = deps.now() - startedAt;
    const resultDetail: TcpResultDetail = {
      host: config.host,
      port: config.port,
      timings: { connectMs, totalMs },
    };
    return {
      state: "pass",
      runId: null,
      durationMs: totalMs,
      errorMessage: null,
      infraError: false,
      statusCode: null,
      resultDetail,
    };
  } catch (err) {
    // `socket.opened` rejected — connection refused / reset / DNS failure. A DOWN
    // signal: `fail`, acked. Close defensively in case a partial socket exists.
    await closeQuietly(socket);
    const totalMs = deps.now() - startedAt;
    return failResult(
      config.host,
      config.port,
      `connection failed: ${err instanceof Error ? err.message : String(err)}`,
      totalMs,
    );
  }
}

/** A `fail` (DOWN) settle — site unreachable, never an infra error. */
function failResult(
  host: string,
  port: number,
  errorMessage: string,
  totalMs: number,
): TcpExecutionResult {
  const resultDetail: TcpResultDetail = {
    host,
    port,
    // A failed connect has no meaningful "connect" time — the totalMs is the
    // time-to-failure; surface it as connectMs too so the detail row isn't blank.
    timings: { connectMs: totalMs, totalMs },
  };
  return {
    state: "fail",
    runId: null,
    durationMs: totalMs,
    errorMessage,
    infraError: false,
    statusCode: null,
    resultDetail,
  };
}

/** Close a socket, swallowing any error — a close failure must not flip the outcome. */
async function closeQuietly(socket: TcpSocketLike): Promise<void> {
  try {
    await socket.close();
  } catch {
    // intentionally ignored — the outcome is already decided
  }
}
