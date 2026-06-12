import {
  generatePlaywrightConfig,
  perTestTimeoutMs,
  specFilename,
} from "@/lib/monitors/playwright-config";
import {
  type LinkedRun,
  runStatusToExecutionState,
} from "@/lib/monitors/run-linking";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
} from "@/lib/monitors/types";
import type { TenantScope } from "@/lib/scope";

/**
 * The container lifecycle of a synthetic-monitor check, as a PURE
 * dependency-injected function — the sandbox twin of the
 * `executor.ts` (pure) / `queues/monitors.ts` (adapter) split. Every effect it
 * needs (acquire the container, mint/revoke the per-run ingest key, resolve the
 * tenant scope, find the streamed run, read the clock) is a parameter on
 * {@link SandboxRunDeps}, so it imports NO `void/sandbox` / `void/env` runtime
 * (which the vitest harness can't resolve). `SandboxExecutor`
 * (`sandbox-executor.ts`) is the thin adapter that wires the real
 * `void/sandbox` + `void/db` IO to these params.
 *
 * The whole point of the extraction is that the COST-CRITICAL teardown — the
 * `finally` that calls `destroy()` so the container scales to zero — is now
 * exercised by unit tests (`__tests__/sandbox-run.test.ts`) on every exit path,
 * instead of living in an untested integration-only class behind a swallowed
 * `.catch`.
 */

/**
 * The container surface this function drives. A structural subset of the
 * Sandbox SDK's stub (which has far more methods) so tests can hand in a plain
 * spy object and the module stays free of the `@cloudflare/sandbox` types.
 */
export interface SandboxHandle {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  exec(
    command: string,
    options: { cwd: string; env: Record<string, string>; timeout: number },
  ): Promise<unknown>;
  /**
   * Tear the container down so it scales to zero immediately. The SDK mandates
   * this ("you MUST call sandbox.destroy() when done"); skipping it leaves the
   * instance to idle out (see `sandbox-policy.ts`), billing container minutes
   * long after a ~45s check finished.
   */
  destroy(): Promise<unknown>;
}

/**
 * Injected effects + config for {@link runSandboxExecution}. Each IO param maps
 * 1:1 to a real `void/*`-backed function the adapter supplies; the rest is
 * resolved config (so the clock and the plan-derived `sleepAfter` stay
 * deterministic under test).
 */
export interface SandboxRunDeps {
  /**
   * Acquire the container stub for this execution id (keyed so a redelivery
   * re-targets the same slot). Constructing the stub does NOT start a
   * container — the first method call (`mkdir`) does — so a throw here (e.g. a
   * capacity/budget denial) means NO container exists to tear down, and the
   * `finally` correctly skips `destroy()`.
   */
  getSandbox: (
    id: string,
    options: { sleepAfter: string },
  ) => Promise<SandboxHandle>;
  mintSyntheticKey: (
    projectId: string,
    executionId: string,
    nowSeconds: number,
  ) => Promise<{ id: string; token: string }>;
  revokeSyntheticKey: (keyId: string, nowSeconds: number) => Promise<void>;
  tenantScopeForMonitor: (monitor: Monitor) => Promise<TenantScope>;
  findRunByIdempotencyKey: (
    scope: TenantScope,
    idempotencyKey: string,
  ) => Promise<LinkedRun | null>;
  /**
   * Classify a thrown error as a sandbox capacity/budget denial (a retryable
   * infra error) and surface its reason, or `null` for any other throw. The
   * adapter wires the real `instanceof SandboxLimitError` check; keeping it a
   * param keeps this module off `void/sandbox`.
   */
  classifyLimitError: (err: unknown) => { reason: string } | null;
  /** Hard wall-clock cap on the whole check (ms). */
  maxDurationMs: number;
  /** Container idle timeout, plan-resolved (`sandbox-policy.ts`). */
  sleepAfter: string;
  /** Public base URL the in-container reporter streams the run to. */
  publicUrl: string;
  /** Epoch milliseconds. */
  now: () => number;
}

/** Wrap an unexpected error as a retryable infra-error result. */
function infraError(err: unknown, durationMs: number): ExecutionResult {
  return {
    state: "error",
    runId: null,
    durationMs,
    errorMessage: err instanceof Error ? err.message : String(err),
    infraError: true,
    // Browser executions carry no inline http result fields.
    statusCode: null,
    resultDetail: null,
  };
}

/**
 * Run the user's `monitor.source` as a one-file Playwright project inside a
 * sandbox container; the in-container `@wrightful/reporter` streams a `runs` row
 * back linked to this execution by `idempotencyKey === execution.id`. Returns
 * an {@link ExecutionResult} the queue consumer keys ack/retry off
 * (`infraError`). See the `SandboxExecutor` docstring for the full error
 * policy; the load-bearing invariant here is that the `finally` ALWAYS tears a
 * started container down.
 */
export async function runSandboxExecution(
  input: { monitor: Monitor; execution: MonitorExecution },
  deps: SandboxRunDeps,
): Promise<ExecutionResult> {
  const { monitor, execution } = input;
  const startedAt = deps.now();

  // A browser monitor must carry a spec; the create/edit schemas enforce that,
  // so this fires only on a bad direct DB write. Fail it TERMINALLY rather than
  // launch a container that finds no tests, streams no run, and reads as an
  // infra error retried to the dead-letter (a wasted container per delivery).
  const source = monitor.source ?? "";
  if (source.trim() === "") {
    return {
      state: "error",
      runId: null,
      durationMs: deps.now() - startedAt,
      errorMessage: "monitor has no Playwright source",
      infraError: false,
      statusCode: null,
      resultDetail: null,
    };
  }

  let scope: TenantScope;
  try {
    scope = await deps.tenantScopeForMonitor(monitor);
  } catch (err) {
    return infraError(err, deps.now() - startedAt);
  }

  let key: { id: string; token: string };
  try {
    key = await deps.mintSyntheticKey(
      scope.projectId,
      execution.id,
      Math.floor(deps.now() / 1000),
    );
  } catch (err) {
    return infraError(err, deps.now() - startedAt);
  }

  // Declared outside the try so `finally` can tear it down even if a later step
  // throws. Left undefined when `getSandbox` itself throws (no container yet).
  let sandbox: SandboxHandle | undefined;
  try {
    sandbox = await deps.getSandbox(execution.id, {
      sleepAfter: deps.sleepAfter,
    });

    const workDir = "/work";
    const testsDir = `${workDir}/tests`;
    await sandbox.mkdir(testsDir, { recursive: true });
    await sandbox.writeFile(
      `${workDir}/playwright.config.ts`,
      generatePlaywrightConfig({ reporterModule: "@wrightful/reporter" }),
    );
    await sandbox.writeFile(`${testsDir}/${specFilename()}`, source);

    // The LINKING env the reporter reads to open the run attributable to this
    // execution. The per-test timeout is clamped BELOW the wall-clock budget
    // (see `perTestTimeoutMs`) so a hanging test is killed by Playwright with
    // headroom for the reporter's final flush before the exec kill.
    const runEnv: Record<string, string> = {
      WRIGHTFUL_URL: deps.publicUrl,
      WRIGHTFUL_TOKEN: key.token,
      WRIGHTFUL_IDEMPOTENCY_KEY: execution.id,
      WRIGHTFUL_MONITOR_ID: monitor.id,
      WRIGHTFUL_RUN_ORIGIN: "synthetic",
      PLAYWRIGHT_TIMEOUT_MS: String(perTestTimeoutMs(deps.maxDurationMs)),
    };

    // Hard wall-clock cap on the whole suite. The SDK's timeout-kill error
    // shape isn't part of its public contract, so classify by elapsed time: an
    // exec failure at or past the budget is the wall-clock kill (a TERMINAL
    // outcome below); anything earlier is a genuine transport/infra error and
    // rethrows to the outer catch.
    const execStartedAt = deps.now();
    try {
      await sandbox.exec("npx playwright test", {
        cwd: workDir,
        env: runEnv,
        timeout: deps.maxDurationMs,
      });
    } catch (err) {
      if (deps.now() - execStartedAt < deps.maxDurationMs) throw err;
    }
    const execTimedOut = deps.now() - execStartedAt >= deps.maxDurationMs;

    // The exec exit code is intentionally NOT the source of truth: a failed
    // test exits non-zero, which is a NORMAL monitor outcome. The real result
    // is the run the reporter streamed — resolve it by the idempotency key.
    const run = await deps.findRunByIdempotencyKey(scope, execution.id);
    const wallMs = deps.now() - startedAt;
    // A wall-clock kill with no settled run is a USER outcome, not an infra
    // error: the per-test timeout (clamped below the budget) would have caught
    // a hanging test, so the script hung outside one — deterministic on re-run.
    // `infraError: false` settles it terminally instead of burning retries.
    if (execTimedOut && (!run || run.status === "running")) {
      return {
        state: "error",
        runId: run?.id ?? null,
        durationMs: wallMs,
        errorMessage:
          `check did not finish within the ${Math.round(deps.maxDurationMs / 1000)}s ` +
          "execution budget (script hung outside a test or teardown stalled; " +
          "less commonly, the runner was interrupted at the deadline)",
        infraError: false,
        statusCode: null,
        resultDetail: null,
      };
    }
    if (!run) {
      return {
        state: "error",
        runId: null,
        durationMs: wallMs,
        errorMessage:
          "container ran but no run was streamed (reporter never opened a run)",
        infraError: true,
        statusCode: null,
        resultDetail: null,
      };
    }
    return {
      state: runStatusToExecutionState(run.status),
      runId: run.id,
      durationMs: run.durationMs || wallMs,
      errorMessage: null,
      infraError: false,
      statusCode: null,
      resultDetail: null,
    };
  } catch (err) {
    // A capacity/budget denial or any transport/setup throw is an infra error
    // → retry. (A non-zero `npx playwright test` exit does NOT throw, so a
    // failing check never lands here.)
    const limit = deps.classifyLimitError(err);
    if (limit) {
      return {
        state: "error",
        runId: null,
        durationMs: deps.now() - startedAt,
        errorMessage: `sandbox unavailable (${limit.reason})`,
        infraError: true,
        statusCode: null,
        resultDetail: null,
      };
    }
    return infraError(err, deps.now() - startedAt);
  } finally {
    // Tear the container down immediately so it scales to zero. Best-effort — a
    // failed teardown must not flip an otherwise-recorded result. Skipped when
    // `sandbox` is undefined (getSandbox threw → no container started).
    if (sandbox) await sandbox.destroy().catch(() => {});
    // Best-effort delete of the single-use per-run ingest key. A lingering key
    // is a tolerable leak (swept by `sweep-synthetic-keys`), never a reason to
    // fail the recorded execution.
    await deps
      .revokeSyntheticKey(key.id, Math.floor(deps.now() / 1000))
      .catch(() => {});
  }
}
