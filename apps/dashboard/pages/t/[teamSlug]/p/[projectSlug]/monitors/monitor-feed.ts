import type { ProjectFeedEvent } from "@/realtime/events";
import type { Props } from "./index.server";
import {
  RECENT_EXECUTION_WINDOW,
  uptimeFromExecutions,
} from "./monitors-ui.shared";

/**
 * The enriched monitor row the list renders — the loader's per-row shape
 * (`Props["monitors"][number]`). Imported as a TYPE only, so this reducer carries
 * no runtime dependency on `index.server.ts` (which pulls in `void/*`); it stays
 * a pure, harness-testable module like `applyProjectFeedEvent`.
 */
type MonitorRow = Props["monitors"][number];

/**
 * Pure reducer folding one project-feed event into the monitors-list rows — the
 * monitors-list twin of `applyProjectFeedEvent`. Both consume the SAME per-project
 * `void/ws` room; this one handles only `monitor-result` and ignores the `run-*`
 * events (which the runs-list reducer owns), so the two lists share one socket
 * without stepping on each other.
 *
 * On a `monitor-result`:
 *   - a monitor not currently displayed is ignored (its update has nowhere to
 *     land — the SSR seed / next load is authoritative), returning the same array
 *     reference so referential-equality consumers don't re-render;
 *   - a redelivery with the SAME outcome (same execution id + state — an `error`
 *     execution can be re-claimed + re-run per the repo's claim contract) is a
 *     no-op, so the strip can't double-count it and React skips the re-render;
 *   - a redelivery that CORRECTED the outcome (e.g. an infra `error` that re-ran
 *     to `pass`) updates the existing strip entry in place, so a real recovery
 *     isn't stranded showing the stale failure until the next load;
 *   - otherwise the row's `lastStatus` / `lastRunAt` advance, the execution
 *     prepends to the strip (newest-first, trimmed to {@link RECENT_EXECUTION_WINDOW}),
 *     and `uptime` is recomputed off the new window via the shared helper.
 */
export function applyMonitorFeedEvent(
  rows: readonly MonitorRow[],
  event: ProjectFeedEvent,
): readonly MonitorRow[] {
  if (event.type !== "monitor-result") return rows;

  const i = rows.findIndex((r) => r.id === event.monitorId);
  if (i === -1) return rows;

  const row = rows[i]!;
  const prevIdx = row.recentExecutions.findIndex(
    (e) => e.id === event.execution.id,
  );
  // True duplicate delivery (same execution, same outcome): no-op — no
  // double-count, and the same array reference lets React bail out of the render.
  if (
    prevIdx !== -1 &&
    row.recentExecutions[prevIdx]!.state === event.execution.state
  ) {
    return rows;
  }

  // A fresh execution prepends (newest-first); a corrected redelivery replaces
  // its existing entry in place rather than being dropped or duplicated.
  // (Strip order is arrival-order for fresh ids, so a late-completing older
  // execution on a tight interval can momentarily sit ahead of a newer one —
  // cosmetic, and the next load/reconnect re-sorts by createdAt.)
  const recentExecutions =
    prevIdx === -1
      ? [event.execution, ...row.recentExecutions].slice(
          0,
          RECENT_EXECUTION_WINDOW,
        )
      : row.recentExecutions.map((e) =>
          e.id === event.execution.id ? event.execution : e,
        );
  const next = [...rows];
  next[i] = {
    ...row,
    lastStatus: event.lastStatus,
    lastRunAt: event.lastRunAt,
    recentExecutions,
    uptime: uptimeFromExecutions(recentExecutions),
  };
  return next;
}
