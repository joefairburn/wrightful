"use client";

import { useCallback, useRef, useState } from "react";
import type { TraceModel } from "../vendor/model-util";

/**
 * Playback engine for the trace Timeline: the `usePlayback` state machine plus
 * the time-search primitives it and the `Playhead` share. Replays the trace
 * like the official viewer — a requestAnimationFrame clock (in `playhead.tsx`)
 * advances from the selected action's startTime and selects the nearest action
 * as it passes. This module only ever touches the strip through
 * `playableActions`, `selectedCallId`, and `onSelect`.
 */

export type TimelineAction = TraceModel["actions"][number];

/** Playback speed presets, matching the official viewer's [.5, 1, 2]. */
export const SPEEDS = [0.5, 1, 2] as const;

/**
 * Binary search over a time-sorted array: the first index whose `key(item)`
 * is `>= t`, or `items.length` if every item sorts before `t`. The one
 * search primitive `nearestFrameIndex` / `nearestActionIndex` /
 * `actionActiveAt` all build on.
 */
export function lowerBoundByTime<T>(
  items: readonly T[],
  t: number,
  key: (item: T) => number,
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The playback target at time `t`: the nearest action to `t` by startTime,
 * snapping forward to the next action when its startTime is closer — the
 * official viewer's "nearest action" playback semantics. Returns -1 only
 * when there are no actions.
 */
export function nearestActionIndex(
  actions: TimelineAction[],
  t: number,
): number {
  if (actions.length === 0) return -1;
  const lb = lowerBoundByTime(actions, t, (a) => a.startTime);
  if (lb === 0) return 0;
  if (lb === actions.length) return actions.length - 1;
  return actions[lb].startTime - t < t - actions[lb - 1].startTime
    ? lb
    : lb - 1;
}

export interface PlaybackController {
  playing: boolean;
  speedIndex: number;
  /** The selection is at the first / last playable action (drives prev/next
   * disabled state) — the controller owns the index math so callers don't
   * re-thread the action count alongside it. */
  atStart: boolean;
  atEnd: boolean;
  hasActions: boolean;
  /** Bumped each time a play session starts — key the <Playhead> on it. */
  session: number;
  /** The model-time position the current play session's clock starts from. */
  playFrom: number;
  /**
   * Where the playhead's clock stops and pauses: the timeline selection's
   * end when one is active, else the trace end.
   */
  playTo: number;
  /** The callId already selected when the current play session started. */
  initialSelectedCallId: string | undefined;
  togglePlay: () => void;
  /**
   * Stop playing without touching the selection — manual strip seeks and
   * <Playhead onComplete> both want exactly this. Stable identity: it's
   * also the one controller callback that crosses into the Playhead's rAF
   * effect, and an unstable reference there would restart the loop (and
   * drop a frame) on every parent re-render.
   */
  pause: () => void;
  stopPlayback: () => void;
  step: (delta: number) => void;
  cycleSpeed: () => void;
}

export function usePlayback({
  windowStartTime,
  windowEndTime,
  playableActions,
  selectedCallId,
  selectedStartTime,
  onSelect,
}: {
  /**
   * The play window: the timeline selection when one is active, else the
   * whole trace. Playback starts no earlier than `windowStartTime` and the
   * playhead pauses at `windowEndTime`; `playableActions` is expected to be
   * pre-filtered to the same window by the workbench.
   */
  windowStartTime: number;
  windowEndTime: number;
  playableActions: TimelineAction[];
  selectedCallId: string | undefined;
  selectedStartTime: number | undefined;
  onSelect: (callId: string) => void;
}): PlaybackController {
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1); // 1×
  const [session, setSession] = useState(0);
  /** The rAF clock's start position + initial selection for the current
   * session — refs so re-renders between "Play" and the session's own
   * effect mounting never race on stale closures. */
  const playFromRef = useRef(windowStartTime);
  const initialSelectedRef = useRef<string | undefined>(undefined);

  const selectedIndex = playableActions.findIndex(
    (a) => a.callId === selectedCallId,
  );
  const hasActions = playableActions.length > 0;
  const lastAction = playableActions[playableActions.length - 1];

  const togglePlay = (): void => {
    if (!hasActions) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // A selection outside the window (a timeline selection was drawn while an
    // out-of-range action was selected) starts from the window's beginning.
    const startFrom =
      selectedStartTime !== undefined &&
      selectedStartTime >= windowStartTime &&
      selectedStartTime < windowEndTime
        ? selectedStartTime
        : windowStartTime;
    if (lastAction && startFrom >= lastAction.startTime) {
      // At/after the last action: restart from the top of the window.
      const first = playableActions[0];
      initialSelectedRef.current = first.callId;
      onSelect(first.callId);
      playFromRef.current = windowStartTime;
    } else {
      initialSelectedRef.current = selectedCallId;
      playFromRef.current = startFrom;
    }
    setSession((s) => s + 1);
    setPlaying(true);
  };

  const pause = useCallback((): void => setPlaying(false), []);

  const stopPlayback = (): void => {
    setPlaying(false);
    const first = playableActions[0];
    if (first) onSelect(first.callId);
  };

  const step = (delta: number): void => {
    if (!hasActions) return;
    const index =
      selectedIndex === -1
        ? 0
        : Math.min(
            playableActions.length - 1,
            Math.max(0, selectedIndex + delta),
          );
    onSelect(playableActions[index].callId);
  };

  const cycleSpeed = (): void => setSpeedIndex((i) => (i + 1) % SPEEDS.length);

  return {
    playing,
    speedIndex,
    atStart: selectedIndex <= 0,
    atEnd: selectedIndex === playableActions.length - 1,
    hasActions,
    session,
    playFrom: playFromRef.current,
    playTo: windowEndTime,
    initialSelectedCallId: initialSelectedRef.current,
    togglePlay,
    pause,
    stopPlayback,
    step,
    cycleSpeed,
  };
}
