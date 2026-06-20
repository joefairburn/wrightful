"use client";

import {
  applyRunProgressEvent,
  seedRunProgressState,
  type RunProgressState,
  type UseRunProgressOptions,
} from "@/realtime/run-progress";
import { useFeedRoom } from "@/realtime/use-feed-room";

export type UseRunRoomOptions = UseRunProgressOptions;

/**
 * Run-detail realtime hook: subscribe to the run's `void/ws` room and fold each
 * `progress` event through the pure reducer (`applyRunProgressEvent`), seeded
 * from SSR data. Shared by `<RunSummaryLive>` and `<RunProgress>`. A thin
 * specialization of `useFeedRoom` (run path + run-progress reducer); see that
 * hook for the reseed + coalesced-reconnect-refresh policy.
 *
 * The seed-prop references (`initialTests` / `initialSummary`) must be
 * referentially STABLE across re-renders of the same page instance — see
 * `useSeededState` for the requirement (the run-detail page memoizes
 * `initialSummary` on a loader prop).
 */
export function useRunRoom(
  runId: string,
  options: UseRunRoomOptions = {},
): RunProgressState {
  const [state] = useFeedRoom(
    "/ws/run/:runId",
    { runId },
    [runId, options.initialTests, options.initialSummary],
    () => seedRunProgressState(options.initialTests, options.initialSummary),
    (prev, event) => applyRunProgressEvent(prev, event),
  );
  return state;
}
