import { HttpExecutor } from "@/lib/monitors/http/http-executor";
import { SandboxExecutor } from "@/lib/monitors/sandbox-executor";
import { StubExecutor } from "@/lib/monitors/stub-executor";
import type { MonitorExecutor } from "@/lib/monitors/types";

/**
 * Resolve a TYPE-DISPATCHING `MonitorExecutor` for the queue consumers. The
 * returned executor routes by `monitor.type` at execute time:
 *   - `"http"` → {@link HttpExecutor} (a plain `fetch`; no container, so it works
 *     in dev/e2e/prod identically — there is no http stub).
 *   - everything else (`"browser"`) → the env-selected browser executor:
 *     `"stub"` is the in-process synthesizer (unit tests + any env exercising the
 *     schedule→queue→ingest pipeline without a container); anything else
 *     (default `"sandbox"`) is the production `SandboxExecutor`.
 *
 * The sweep routes http jobs to `queues/uptime.ts` and browser jobs to
 * `queues/monitors.ts`, so each consumer normally only sees its own type — but
 * dispatching here is belt-and-braces: a job that somehow lands on the other
 * queue is still executed correctly for its type.
 *
 * NOTE: importing `SandboxExecutor` pulls in `void/sandbox` (Docker on local
 * `vp dev`). This is the ONLY module that imports the concrete browser
 * executors, so it is imported only by the queue consumers — never by the pure
 * `executor.ts` orchestrator or any unit test (keeping those free of the runtime
 * imports the vitest harness can't resolve).
 */
export function resolveExecutor(name: string): MonitorExecutor {
  const browserExecutor =
    name === "stub" ? new StubExecutor() : new SandboxExecutor();
  const httpExecutor = new HttpExecutor();
  return {
    execute: (input) =>
      input.monitor.type === "http"
        ? httpExecutor.execute(input)
        : browserExecutor.execute(input),
  };
}
