"use client";

import { ChevronLeft, ChevronRight, Pause, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TraceModel } from "../vendor/model-util";

/**
 * Playback engine (state + rAF clock) and the control-cluster UI (prev /
 * play–pause / stop / next / speed) for the trace Timeline. Replays the
 * trace like the official viewer: a requestAnimationFrame clock advances a
 * playhead from the selected action's startTime and selects the nearest
 * action as it passes.
 *
 * This module only ever touches the strip through `playableActions`,
 * `selectedCallId`, and `onSelect` — it knows nothing about the filmstrip,
 * hover preview, or seek handling, which stay in `timeline.tsx`.
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
function nearestActionIndex(actions: TimelineAction[], t: number): number {
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
  selectedIndex: number;
  hasActions: boolean;
  /** Bumped each time a play session starts — key the <Playhead> on it. */
  session: number;
  /** The model-time position the current play session's clock starts from. */
  playFrom: number;
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
  traceStartTime,
  playableActions,
  selectedCallId,
  selectedStartTime,
  onSelect,
}: {
  traceStartTime: number;
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
  const playFromRef = useRef(traceStartTime);
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
    const startFrom = selectedStartTime ?? traceStartTime;
    if (lastAction && startFrom >= lastAction.startTime) {
      // At/after the last action: restart from the top.
      const first = playableActions[0];
      initialSelectedRef.current = first.callId;
      onSelect(first.callId);
      playFromRef.current = traceStartTime;
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
    selectedIndex,
    hasActions,
    session,
    playFrom: playFromRef.current,
    initialSelectedCallId: initialSelectedRef.current,
    togglePlay,
    pause,
    stopPlayback,
    step,
    cycleSpeed,
  };
}

/**
 * The moving playhead line while replaying. Owns its own rAF loop and
 * positions itself by mutating `style.left` directly on its own ref — a
 * per-frame `setState` here would re-render the whole Timeline 60×/sec for a
 * value only this 1px div consumes. Reports action-boundary crossings via
 * `onSelect` and end-of-trace via `onComplete`. Everything that can change
 * identity mid-session — the callbacks and the speed — is read through refs,
 * so the rAF effect never restarts while playing: a restart re-baselines the
 * clock and drops a frame, which would visibly stall the playhead whenever
 * the parent re-renders per-frame (e.g. hover state on pointermove).
 *
 * One instance = one play session — the parent remounts this component
 * (via a `key`) each time "Play" starts a fresh session.
 */
export function Playhead({
  startTime,
  traceStartTime,
  traceEndTime,
  speedIndex,
  playableActions,
  initialSelectedCallId,
  onSelect,
  onComplete,
}: {
  startTime: number;
  traceStartTime: number;
  traceEndTime: number;
  speedIndex: number;
  playableActions: TimelineAction[];
  initialSelectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  onComplete: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const positionRef = useRef(startTime);
  const lastSelectedRef = useRef(initialSelectedCallId);
  const speedRef = useRef<number>(SPEEDS[speedIndex]);
  const onSelectRef = useRef(onSelect);
  const onCompleteRef = useRef(onComplete);
  const duration = traceEndTime - traceStartTime;

  useEffect(() => {
    speedRef.current = SPEEDS[speedIndex];
  }, [speedIndex]);
  // Assigned post-commit (never during render) so an abandoned concurrent
  // render can't leave its callbacks behind in the refs.
  useEffect(() => {
    onSelectRef.current = onSelect;
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    const setLeft = (t: number): void => {
      const node = ref.current;
      if (!node || duration <= 0) return;
      const fraction = Math.min(
        1,
        Math.max(0, (t - traceStartTime) / duration),
      );
      node.style.left = `${fraction * 100}%`;
    };

    let raf = 0;
    let last: number | undefined;
    setLeft(positionRef.current);
    const tick = (timestamp: number): void => {
      // The first frame only baselines the clock — deltas start on frame 2.
      if (last !== undefined) {
        const next = Math.min(
          traceEndTime,
          positionRef.current + (timestamp - last) * speedRef.current,
        );
        positionRef.current = next;
        setLeft(next);
        const index = nearestActionIndex(playableActions, next);
        const action = index >= 0 ? playableActions[index] : undefined;
        if (action && action.callId !== lastSelectedRef.current) {
          lastSelectedRef.current = action.callId;
          onSelectRef.current(action.callId);
        }
        if (next >= traceEndTime) {
          onCompleteRef.current();
          return;
        }
      }
      last = timestamp;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [traceStartTime, traceEndTime, duration, playableActions]);

  const initialFraction =
    duration > 0
      ? Math.min(1, Math.max(0, (startTime - traceStartTime) / duration))
      : 0;

  return (
    <div
      ref={ref}
      data-testid="timeline-playhead"
      className="pointer-events-none absolute inset-y-0 w-px bg-ring"
      style={{ left: `${initialFraction * 100}%` }}
    />
  );
}

/** Small ghost icon button for the playback cluster. */
function PlaybackButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded text-fg-3 transition-colors hover:bg-bg-2 hover:text-fg-2 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * Playback control cluster: prev / play–pause / stop / next / speed. Rendered
 * in the snapshot pane's Before/Action/After nav (to the right, before the
 * paint-`<canvas>` button) rather than inside the timeline strip, so its
 * clicks never collide with the strip's pointer-seek handlers. The playback
 * engine lives one level up in the workbench (see `usePlayback`) so this
 * cluster and the timeline's moving Playhead share a single controller.
 */
export function PlaybackControls({
  playing,
  hasActions,
  selectedIndex,
  actionsCount,
  speedIndex,
  onTogglePlay,
  onStop,
  onStep,
  onCycleSpeed,
}: {
  playing: boolean;
  hasActions: boolean;
  selectedIndex: number;
  actionsCount: number;
  speedIndex: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onStep: (delta: number) => void;
  onCycleSpeed: () => void;
}): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <PlaybackButton
        label="Previous action"
        disabled={selectedIndex <= 0}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft className="size-3.5" />
      </PlaybackButton>
      <PlaybackButton
        label={playing ? "Pause" : "Play"}
        disabled={!hasActions}
        onClick={onTogglePlay}
      >
        {playing ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Play className="size-3.5 fill-current" />
        )}
      </PlaybackButton>
      <PlaybackButton
        label="Stop"
        disabled={!hasActions || (selectedIndex <= 0 && !playing)}
        onClick={onStop}
      >
        <Square className="size-3 fill-current" />
      </PlaybackButton>
      <PlaybackButton
        label="Next action"
        disabled={!hasActions || selectedIndex === actionsCount - 1}
        onClick={() => onStep(1)}
      >
        <ChevronRight className="size-3.5" />
      </PlaybackButton>
      <button
        type="button"
        aria-label="Playback speed"
        title="Playback speed"
        onClick={onCycleSpeed}
        className="flex h-6 min-w-8 items-center justify-center rounded px-1 font-mono text-micro text-fg-3 tabular-nums transition-colors hover:bg-bg-2 hover:text-fg-2"
      >
        {SPEEDS[speedIndex]}×
      </button>
    </div>
  );
}
