"use client";

import { useRouter } from "@void/react";
import {
  applyRunProgressEvent,
  seedRunProgressState,
  type RunProgressState,
  type UseRunProgressOptions,
} from "@/realtime/run-progress";
import { requestReconnectRefresh } from "@/realtime/reconnect-refresh";
import { useRoom } from "@/realtime/use-room";
import { useSeededState } from "@/realtime/use-seeded-state";

export type UseRunRoomOptions = UseRunProgressOptions;

/**
 * Run-detail realtime hook: subscribe to the run's `void/ws` room and fold each
 * `progress` event through the pure reducer (`applyRunProgressEvent`), seeded
 * from SSR data. Shared by `<RunSummaryLive>` and `<RunProgress>`.
 *
 * The live state reseeds whenever the seed identity (`runId` + the seed-prop
 * references) changes — see `useSeededState` for the unkeyed-navigation
 * rationale and the referential-stability requirement on the seed props.
 *
 * On a WS re-open after a drop (rooms have no replay, so any broadcast missed
 * while disconnected is gone — per-test rows included) the hook triggers
 * `router.refresh()`: the loader re-runs with fresh tests + summary and the
 * reseed above folds them in. Coalesced via `requestReconnectRefresh` so the
 * several leaves sharing this room's socket issue ONE refresh per reconnect
 * burst, not one each.
 */
export function useRunRoom(
  runId: string,
  options: UseRunRoomOptions = {},
): RunProgressState {
  const router = useRouter();

  const [state, setState] = useSeededState<RunProgressState>(
    [runId, options.initialTests, options.initialSummary],
    () => seedRunProgressState(options.initialTests, options.initialSummary),
  );

  useRoom(
    "/ws/run/:runId",
    { runId },
    (event) => {
      setState((prev) => applyRunProgressEvent(prev, event));
    },
    () => {
      requestReconnectRefresh(() => router.refresh());
    },
  );

  return state;
}
