"use client";

import { useEffect } from "react";
import { fetch } from "void/client";
import type { RunResultsResponse } from "@/lib/run-results-page";
import {
  applyRunProgressEvent,
  mergeBackfilledTests,
  seedRunProgressState,
  type RunProgressState,
  type UseRunProgressOptions,
} from "@/realtime/run-progress";
import { useFeedRoom } from "@/realtime/use-feed-room";

export interface UseRunRoomBackfill {
  teamSlug: string;
  projectSlug: string;
  /** `nextCursor` from the SSR seed page — null when the seed was complete. */
  cursor: string | null;
}

export type UseRunRoomOptions = UseRunProgressOptions & {
  /**
   * When set (and `cursor` is non-null), page the REST of the run's
   * testResults in from GET /results after mount, so consumers that derive
   * counts/lists from `byId` (the Tests tab) see the full run, not just the
   * SSR seed window. Leave unset for consumers that only read `summary`
   * (`RunSummaryLive`) — they'd fetch the same pages for nothing.
   */
  backfill?: UseRunRoomBackfill;
};

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
  const [state, setState] = useFeedRoom(
    "/ws/run/:runId",
    { runId },
    [runId, options.initialTests, options.initialSummary],
    () => seedRunProgressState(options.initialTests, options.initialSummary),
    (prev, event) => applyRunProgressEvent(prev, event),
  );

  const { backfill, initialTests } = options;
  const teamSlug = backfill?.teamSlug;
  const projectSlug = backfill?.projectSlug;
  const initialCursor = backfill?.cursor ?? null;

  // Back-paginate the tail of the run beyond the SSR seed window. Keyed on
  // `initialTests` (not just the cursor string) on purpose: a reconnect
  // refresh re-runs the loader and the render-time reseed above rebuilds
  // `byId` from the fresh seed alone, dropping previously back-filled rows —
  // the new seed identity re-runs this effect so they're re-fetched. Rows
  // merge existing-wins (see `mergeBackfilledTests`), so a live event landing
  // mid-pagination is never clobbered by the older DB page.
  useEffect(() => {
    if (!initialCursor || !teamSlug || !projectSlug) return;
    const controller = new AbortController();
    void (async () => {
      try {
        let cursor: string | null = initialCursor;
        while (cursor) {
          // Explicit annotation: `cursor`'s loop narrowing feeds this call's
          // `query` while being reassigned from its result — without it TS
          // reports a circular-inference TS7022 on `page`.
          const page: RunResultsResponse = await fetch(
            "/api/t/:teamSlug/p/:projectSlug/runs/:runId/results",
            {
              params: { teamSlug, projectSlug, runId },
              query: { cursor },
              signal: controller.signal,
            },
          );
          if (controller.signal.aborted) return;
          setState((prev) => mergeBackfilledTests(prev, page.results));
          cursor = page.nextCursor;
        }
      } catch {
        // Aborted unmount/reseed or a transient fetch failure. The seed +
        // live events still render; the next reconnect refresh retries.
      }
    })();
    return () => controller.abort();
  }, [runId, teamSlug, projectSlug, initialCursor, initialTests, setState]);

  return state;
}
