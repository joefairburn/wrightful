"use client";

import { useRouter } from "@void/react";
import type { RunOriginFilter } from "@/lib/runs-filters";
import type { RunListRowData } from "@/realtime/events";
import { applyProjectFeedEvent } from "@/realtime/project-feed";
import { requestReconnectRefresh } from "@/realtime/reconnect-refresh";
import { useRoom } from "@/realtime/use-room";
import { useSeededState } from "@/realtime/use-seeded-state";

export interface UseProjectRoomOptions {
  /**
   * Whether `run-created` events may prepend rows — true only on the first,
   * otherwise-unfiltered page (a filtered/paginated view must not be injected
   * with rows that don't belong to it). The origin view alone doesn't disable
   * this; `origin` below gates which provenance is accepted.
   */
  acceptNewRuns: boolean;
  /**
   * The list's active origin view. The server broadcasts `run-created` for ALL
   * runs (synthetic monitor runs included); the reducer prepends only rows
   * whose `origin` matches this view, so the CI view isn't drowned by
   * monitor-cadence runs while the Synthetic/All views stay live.
   */
  origin: RunOriginFilter;
}

/**
 * Subscribe to the project's `void/ws` room and fold `run-created` /
 * `run-progress` into the runs-list rows via the pure reducer
 * (`applyProjectFeedEvent`). Seeds from the SSR `initialRows`; returns the live
 * row list.
 *
 * The rows reseed whenever the seed identity (`projectId` + the `initialRows`
 * reference) changes — see `useSeededState` for the unkeyed-navigation
 * rationale (a filter/page change re-renders the same mounted component with a
 * fresh `initialRows` from the loader).
 *
 * On a WS re-open after a drop (rooms have no replay, so any broadcast missed
 * while disconnected is gone) the hook triggers `router.refresh()` — the
 * loader re-runs and the reseed above folds the fresh rows in. Coalesced via
 * `requestReconnectRefresh` (one refresh per reconnect burst).
 *
 * `options` is read fresh inside the handler (the closure is re-bound each
 * render by `useRoom`), so the current view's `acceptNewRuns` / `origin`
 * always apply.
 */
export function useProjectRoom(
  projectId: string,
  initialRows: readonly RunListRowData[],
  options: UseProjectRoomOptions,
): readonly RunListRowData[] {
  const router = useRouter();

  const [rows, setRows] = useSeededState<readonly RunListRowData[]>(
    [projectId, initialRows],
    () => [...initialRows],
  );

  useRoom(
    "/ws/project/:projectId",
    { projectId },
    (event) => {
      setRows((prev) => applyProjectFeedEvent(prev, event, options));
    },
    () => {
      requestReconnectRefresh(() => router.refresh());
    },
  );

  return rows;
}
