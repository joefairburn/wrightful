"use client";

import { useState } from "react";
import {
  applyRunProgressEvent,
  seedRunProgressState,
  type RunProgressState,
  type UseRunProgressOptions,
} from "@/realtime/run-progress";
import { useRoom } from "@/realtime/use-room";

/**
 * Run-detail realtime hook: subscribe to the run's `void/ws` room and fold each
 * `progress` event through the pure reducer (`applyRunProgressEvent`), seeded
 * from SSR data. Shared by `<RunSummaryLive>` and `<RunProgress>`.
 */
export function useRunRoom(
  runId: string,
  options: UseRunProgressOptions = {},
): RunProgressState {
  const [state, setState] = useState<RunProgressState>(() =>
    seedRunProgressState(options.initialTests, options.initialSummary),
  );

  useRoom("/ws/run/:runId", { runId }, (event) => {
    setState((prev) => applyRunProgressEvent(prev, event));
  });

  return state;
}
