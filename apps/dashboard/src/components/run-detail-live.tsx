"use client";

import type React from "react";
import { StatusGlyph } from "@/components/status-glyph";
import {
  currentSummary,
  type RunProgressSummary,
} from "@/realtime/run-progress";
import { useRunRoom } from "@/realtime/use-run-room";
import { LiveDuration } from "@/components/live-duration";

/**
 * Live run-detail header fields that the RSC page used to render from STATIC SSR
 * `run.*` props — so they went stale until a reload, most visibly the run status
 * glyph, which kept showing "running" after a run completed (the bug these fix).
 *
 * Each subscribes to the run's `void/ws` room via `useRunRoom` and reads the live
 * `summary` (falling back to the SSR `initialSummary` until the first event), so
 * they track streaming results + run completion in lockstep with the summary
 * tiles (`<RunSummaryLive>`) and the per-test list (`<RunProgress>`). They are
 * separate leaves rather than one island because they sit in different parts of
 * the page (sticky H1 vs the tab bar); `useRoom` ref-counts the connection, so
 * all of them — plus the tiles + list — share ONE WebSocket to the room.
 */

/** The run status glyph in the sticky H1. Live so completion flips it without a reload. */
export function RunStatusGlyphLive({
  runId,
  initialSummary,
  size,
}: {
  runId: string;
  initialSummary: RunProgressSummary;
  size: number;
}): React.ReactElement {
  const state = useRunRoom(runId, { initialSummary });
  return (
    <StatusGlyph
      size={size}
      status={currentSummary(state, initialSummary).status}
    />
  );
}

/**
 * The run duration in the sticky H1. While running it ticks wall-clock elapsed
 * since `createdAt`; on completion it switches to the WS-delivered final
 * `durationMs` (see {@link LiveDuration}). `createdAt` (unix seconds) is the
 * immutable run start, so it comes from the SSR prop, not the live summary.
 */
export function RunDurationLive({
  runId,
  initialSummary,
  createdAt,
}: {
  runId: string;
  initialSummary: RunProgressSummary;
  createdAt: number;
}): React.ReactElement {
  const summary = currentSummary(
    useRunRoom(runId, { initialSummary }),
    initialSummary,
  );
  return (
    <span className="font-mono tabular-nums">
      <LiveDuration
        completedAt={summary.completedAt}
        createdAt={createdAt}
        durationMs={summary.durationMs}
        status={summary.status}
      />
    </span>
  );
}

/** The Tests-tab total count. Live so it climbs as results stream + settles on completion. */
export function RunTestCountLive({
  runId,
  initialSummary,
}: {
  runId: string;
  initialSummary: RunProgressSummary;
}): React.ReactElement {
  const state = useRunRoom(runId, { initialSummary });
  return <>{currentSummary(state, initialSummary).totalTests}</>;
}
