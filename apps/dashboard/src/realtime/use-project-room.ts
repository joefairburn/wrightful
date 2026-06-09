"use client";

import { useState } from "react";
import type { RunListRowData } from "@/realtime/events";
import { applyProjectFeedEvent } from "@/realtime/project-feed";
import { useRoom } from "@/realtime/use-room";

/**
 * Subscribe to the project's `void/ws` room and fold `run-created` /
 * `run-progress` into the runs-list rows via the pure reducer
 * (`applyProjectFeedEvent`). Seeds from the SSR `initialRows`; returns the live
 * row list.
 *
 * `acceptNewRuns` is read fresh inside the handler (the closure is re-bound each
 * render by `useRoom`), so a filtered/paginated view won't prepend new runs.
 */
export function useProjectRoom(
  projectId: string,
  initialRows: readonly RunListRowData[],
  options: { acceptNewRuns: boolean },
): readonly RunListRowData[] {
  const [rows, setRows] = useState<readonly RunListRowData[]>(() => [
    ...initialRows,
  ]);

  useRoom("/ws/project/:projectId", { projectId }, (event) => {
    setRows((prev) =>
      applyProjectFeedEvent(prev, event, options.acceptNewRuns),
    );
  });

  return rows;
}
