import type { ProjectFeedEvent, RunListRowData } from "@/realtime/events";

/**
 * Pure reducer folding one project-feed event into the runs-list rows, used by
 * the WS project-room hook (`useProjectRoom`) so the merge rules are
 * unit-testable without React or a live connection.
 *
 * Rules:
 *   - `run-progress`: overlay the summary onto the matching row IN PLACE; a row
 *     not currently displayed is ignored (its update has nowhere to land — the
 *     SSR seed / next load is authoritative). Returns the same array reference
 *     when nothing matched so referential-equality consumers don't re-render.
 *   - `run-created`: prepend the new row — but only when `acceptNewRuns` (the
 *     default, unfiltered first page) and not already present (dedupe by id, so
 *     a create that races the SSR seed doesn't double-insert).
 */
export function applyProjectFeedEvent(
  rows: readonly RunListRowData[],
  event: ProjectFeedEvent,
  acceptNewRuns: boolean,
): readonly RunListRowData[] {
  if (event.type === "run-progress") {
    const i = rows.findIndex((r) => r.id === event.runId);
    if (i === -1) return rows;
    const next = [...rows];
    next[i] = { ...next[i], ...event.summary };
    return next;
  }
  if (event.type === "run-created") {
    if (!acceptNewRuns) return rows;
    if (rows.some((r) => r.id === event.run.id)) return rows;
    return [event.run, ...rows];
  }
  return rows;
}
