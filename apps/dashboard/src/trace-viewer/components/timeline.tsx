"use client";

import { ChevronLeft, ChevronRight, Pause, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import { sha1Path } from "../model";
import type { TraceBridge } from "../use-trace-model";
import { useObjectUrl } from "../use-object-url";
import type { PageEntry } from "../vendor/entries";
import type { MultiTraceModel } from "../vendor/model-util";

/**
 * Filmstrip + click-to-seek timeline strip below the snapshot pane, with a
 * playback control cluster (prev / play–pause / stop / next / speed) that
 * replays the trace like the official viewer: a requestAnimationFrame clock
 * advances a playhead from the selected action's startTime and selects the
 * nearest action as it passes.
 *
 * Screencast frames are served by the trace-viewer service worker under
 * `sha1/<name>?trace=…`, and that route only answers fetches from the
 * SW-CONTROLLED bridge client (see `use-trace-model.ts` / `bridge.html`) — a
 * plain `<img src="/trace-viewer/sha1/…">` from this (uncontrolled) dashboard
 * page would 404. So every thumbnail is fetched as a blob through
 * `bridge.fetchBlob` (via `useObjectUrl`) and rendered from an object URL
 * instead. Hooks can't be called in a loop, so each thumbnail is its own
 * child component (`FilmstripThumb`).
 */

type ScreencastFrame = PageEntry["screencastFrames"][number];
type TimelineAction = MultiTraceModel["actions"][number];

/**
 * Overall strip height: a ~16px axis/cursor row, an ~8px action-bars lane,
 * then the filmstrip row.
 */
const AXIS_HEIGHT = 16;
const BARS_HEIGHT = 8;
const STRIP_HEIGHT = 56;
const TOTAL_HEIGHT = AXIS_HEIGHT + BARS_HEIGHT + STRIP_HEIGHT;

/** Never render more thumbnails than this, however wide the container. */
const MAX_THUMBS = 60;

/** Size of the hover thumbnail preview card (width follows the frame's aspect). */
const PREVIEW_HEIGHT = 220;

/**
 * Vertical room the hover preview card needs when rendered above the strip:
 * PREVIEW_HEIGHT + card padding + time-label row + mb-2 margin. When the
 * viewport space above the strip is smaller than this (e.g. the Timeline sits
 * at the very top of an overflow-hidden dialog), the card flips below instead.
 */
const PREVIEW_CLEARANCE = PREVIEW_HEIGHT + 40;

/** Playback speed presets, matching the official viewer's [.5, 1, 2]. */
const SPEEDS = [0.5, 1, 2] as const;

/** Binary search for the frame whose timestamp is closest to `t`. */
function nearestFrameIndex(frames: ScreencastFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  if (
    lo > 0 &&
    Math.abs(frames[lo - 1].timestamp - t) <= Math.abs(frames[lo].timestamp - t)
  ) {
    return lo - 1;
  }
  return lo;
}

/**
 * The playback target at time `t`: binary search for the LAST action with
 * startTime <= t, then snap forward to the next action when its startTime is
 * closer to `t` — the official viewer's "nearest action" playback semantics.
 * Returns -1 only when there are no actions.
 */
function nearestActionIndex(actions: TimelineAction[], t: number): number {
  if (actions.length === 0) return -1;
  if (actions[0].startTime > t) return 0;
  let lo = 0;
  let hi = actions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (actions[mid].startTime <= t) lo = mid;
    else hi = mid - 1;
  }
  if (
    lo + 1 < actions.length &&
    actions[lo + 1].startTime - t < t - actions[lo].startTime
  ) {
    return lo + 1;
  }
  return lo;
}

/** The action active at time `t`: the latest-starting action with startTime <= t. */
function actionActiveAt(
  actions: TimelineAction[],
  t: number,
): TimelineAction | undefined {
  let candidate: TimelineAction | undefined;
  for (const action of actions) {
    if (action.startTime <= t) {
      if (!candidate || action.startTime > candidate.startTime) {
        candidate = action;
      }
    }
  }
  return candidate ?? actions[0];
}

export function Timeline({
  model,
  bridge,
  selectedCallId,
  onSelect,
  className,
}: {
  model: MultiTraceModel;
  bridge: TraceBridge;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  className?: string;
}): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const duration = model.endTime - model.startTime;

  const allFrames = useMemo<ScreencastFrame[]>(() => {
    const frames = model.pages.flatMap((p) => p.screencastFrames);
    frames.sort((a, b) => a.timestamp - b.timestamp);
    return frames;
  }, [model]);

  // A uniform slot width (all thumbs share one aspect ratio, taken from the
  // first frame) is what lets evenly-time-spaced slots also land evenly
  // spaced in pixels — the strip is a plain flex row, no per-thumb math.
  const aspect =
    allFrames.length > 0 ? allFrames[0].width / allFrames[0].height : 16 / 9;
  const thumbWidth = Math.max(1, Math.round(STRIP_HEIGHT * aspect));
  const slotCount =
    allFrames.length > 0 && containerWidth > 0
      ? Math.min(
          MAX_THUMBS,
          Math.max(0, Math.floor(containerWidth / thumbWidth)),
        )
      : 0;

  const slots = useMemo<ScreencastFrame[]>(() => {
    if (slotCount === 0 || duration <= 0) return [];
    const result: ScreencastFrame[] = [];
    for (let i = 0; i < slotCount; i++) {
      const t = model.startTime + ((i + 0.5) / slotCount) * duration;
      result.push(allFrames[nearestFrameIndex(allFrames, t)]);
    }
    return result;
  }, [allFrames, slotCount, duration, model.startTime]);

  const selectedAction = useMemo(
    () => model.actions.find((a) => a.callId === selectedCallId),
    [model, selectedCallId],
  );

  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  /** Flip the hover preview card below the strip when there's no room above. */
  const [previewBelow, setPreviewBelow] = useState(false);
  const draggingRef = useRef(false);

  // ---- Playback ----------------------------------------------------------
  // Playback, prev/next stepping, and click-to-seek walk the DEFAULT-VISIBLE
  // action set — `filteredActions([])` drops the noise groups (route/getter/
  // configuration) the action list hides by default. Selecting one of those
  // would land on an action with no row in the list (they're filtered out of
  // its tree entirely), so "Next" would appear to do nothing. The bars lane
  // below still renders every action.
  const playableActions = useMemo(() => model.filteredActions([]), [model]);
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1); // 1×
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  /** The rAF clock's current position — a ref so ticks never re-close. */
  const playheadRef = useRef(model.startTime);
  /** Last callId this component itself selected, to dedupe onSelect calls. */
  const lastSelectedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    const speed = SPEEDS[speedIndex];
    let raf = 0;
    let last: number | undefined;
    const tick = (timestamp: number): void => {
      // The first frame only baselines the clock — deltas start on frame 2.
      if (last !== undefined) {
        const next = Math.min(
          model.endTime,
          playheadRef.current + (timestamp - last) * speed,
        );
        playheadRef.current = next;
        setPlayheadTime(next);
        const index = nearestActionIndex(playableActions, next);
        const action = index >= 0 ? playableActions[index] : undefined;
        if (action && action.callId !== lastSelectedRef.current) {
          lastSelectedRef.current = action.callId;
          onSelect(action.callId);
        }
        if (next >= model.endTime) {
          setPlaying(false);
          return;
        }
      }
      last = timestamp;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speedIndex, model, playableActions, onSelect]);

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
    const startFrom = selectedAction
      ? selectedAction.startTime
      : model.startTime;
    if (lastAction && startFrom >= lastAction.startTime) {
      // At/after the last action: restart from the top.
      const first = playableActions[0];
      lastSelectedRef.current = first.callId;
      onSelect(first.callId);
      playheadRef.current = model.startTime;
      setPlayheadTime(model.startTime);
    } else {
      lastSelectedRef.current = selectedCallId;
      playheadRef.current = startFrom;
      setPlayheadTime(startFrom);
    }
    setPlaying(true);
  };

  const stopPlayback = (): void => {
    setPlaying(false);
    setPlayheadTime(null);
    const first = playableActions[0];
    if (first) {
      lastSelectedRef.current = first.callId;
      onSelect(first.callId);
    }
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

  if (duration <= 0) return null;

  const fractionAtClientX = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToFraction = (fraction: number): void => {
    const t = model.startTime + fraction * duration;
    const action = actionActiveAt(playableActions, t);
    if (action) onSelect(action.callId);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    // Manual seeking takes over from playback.
    setPlaying(false);
    const fraction = fractionAtClientX(event.clientX);
    setHoverFraction(fraction);
    seekToFraction(fraction);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const fraction = fractionAtClientX(event.clientX);
    setHoverFraction(fraction);
    // The Timeline can sit at the very top of an overflow-hidden dialog, in
    // which case an above-the-strip preview card would be clipped — measure
    // the viewport space above and flip the card below when it won't fit.
    const top = containerRef.current?.getBoundingClientRect().top ?? 0;
    setPreviewBelow(top < PREVIEW_CLEARANCE);
    if (draggingRef.current) seekToFraction(fraction);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const selectedStartFraction = selectedAction
    ? (selectedAction.startTime - model.startTime) / duration
    : null;
  const selectedEndFraction = selectedAction
    ? (selectedAction.endTime - model.startTime) / duration
    : null;

  // The frame nearest the hovered TIME (not a slot sample) drives the hover
  // preview card. Keying/fetching by its sha1 means the card only refetches
  // when the cursor actually crosses into a new frame's window.
  const hoverTime =
    hoverFraction !== null ? model.startTime + hoverFraction * duration : null;
  const previewFrame =
    hoverTime !== null && allFrames.length > 0
      ? allFrames[nearestFrameIndex(allFrames, hoverTime)]
      : undefined;
  const previewAspect = previewFrame
    ? previewFrame.width / previewFrame.height
    : aspect;
  const previewWidth = Math.max(1, Math.round(PREVIEW_HEIGHT * previewAspect));
  const previewLeft =
    hoverFraction !== null && containerWidth > 0
      ? Math.min(
          Math.max(hoverFraction * containerWidth - previewWidth / 2, 0),
          Math.max(0, containerWidth - previewWidth),
        )
      : 0;

  const playheadFraction =
    playing && playheadTime !== null
      ? (playheadTime - model.startTime) / duration
      : null;

  return (
    <div
      className={cn("flex w-full select-none", className)}
      style={{ height: TOTAL_HEIGHT }}
    >
      {/* Playback control cluster: prev / play–pause / stop / next / speed.
       * Lives BESIDE the strip (not inside it) so its clicks never collide
       * with the strip's pointer-seek handlers. */}
      <div className="flex shrink-0 items-center gap-0.5 border-r border-line-1 px-1.5">
        <PlaybackButton
          label="Previous action"
          disabled={selectedIndex <= 0}
          onClick={() => step(-1)}
        >
          <ChevronLeft className="size-3.5" />
        </PlaybackButton>
        <PlaybackButton
          label={playing ? "Pause" : "Play"}
          disabled={!hasActions}
          onClick={togglePlay}
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
          onClick={stopPlayback}
        >
          <Square className="size-3 fill-current" />
        </PlaybackButton>
        <PlaybackButton
          label="Next action"
          disabled={!hasActions || selectedIndex === playableActions.length - 1}
          onClick={() => step(1)}
        >
          <ChevronRight className="size-3.5" />
        </PlaybackButton>
        <button
          type="button"
          aria-label="Playback speed"
          title="Playback speed"
          onClick={() => setSpeedIndex((i) => (i + 1) % SPEEDS.length)}
          className="flex h-6 min-w-8 items-center justify-center rounded px-1 font-mono text-11 text-fg-3 tabular-nums transition-colors hover:bg-bg-2 hover:text-fg-2"
        >
          {SPEEDS[speedIndex]}×
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative min-w-0 flex-1 cursor-crosshair"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!draggingRef.current) setHoverFraction(null);
        }}
      >
        {/* Action bars row: one slim bar per action (zero/negative-duration
         * actions skipped), failed actions in fail red and the rest neutral;
         * the selected action's bar is brighter and taller. Purely decorative
         * — pointer-events-none so the strip-level handlers above still own
         * click/drag seeking. */}
        <div
          className="pointer-events-none absolute inset-x-0"
          style={{ top: AXIS_HEIGHT, height: BARS_HEIGHT }}
        >
          {model.actions.map((action) => {
            const span = action.endTime - action.startTime;
            if (span <= 0) return null;
            const isSelected = action.callId === selectedCallId;
            const left =
              ((action.startTime - model.startTime) / duration) * 100;
            const width = (span / duration) * 100;
            return (
              <div
                key={action.callId}
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 rounded-sm",
                  isSelected
                    ? "h-full bg-ring"
                    : action.error
                      ? "h-1.5 bg-fail"
                      : "h-1.5 bg-fg-4/50",
                )}
                style={{ left: `${left}%`, width: `${width}%`, minWidth: 2 }}
              />
            );
          })}
        </div>

        {/* Filmstrip row. Falls back to a plain fill when the trace has no
         * screencast frames — click-to-seek still works either way. */}
        <div
          className="absolute inset-x-0 bottom-0 flex overflow-hidden bg-bg-2"
          style={{ height: STRIP_HEIGHT }}
        >
          {slots.map((frame, i) => (
            <FilmstripThumb
              key={`${frame.sha1}-${i}`}
              bridge={bridge}
              traceUri={model.traceUri}
              frame={frame}
              width={thumbWidth}
              height={STRIP_HEIGHT}
            />
          ))}
        </div>

        {/* Selected-action window overlay, spanning the full strip height. */}
        {selectedStartFraction !== null && selectedEndFraction !== null ? (
          <div
            className="pointer-events-none absolute inset-y-0 border-x border-ring bg-ring/20"
            style={{
              left: `${selectedStartFraction * 100}%`,
              width: `${Math.max(0, selectedEndFraction - selectedStartFraction) * 100}%`,
            }}
          />
        ) : null}

        {/* Moving playhead while replaying — distinct from the hover cursor. */}
        {playheadFraction !== null ? (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-ring"
            style={{
              left: `${Math.min(1, Math.max(0, playheadFraction)) * 100}%`,
            }}
          />
        ) : null}

        {/* Hover cursor: a vertical line through the full height. When the
         * trace has screencast frames, a floating preview card (thumbnail +
         * time label) takes the place of the plain offset label; with no
         * frames the plain mono label is unchanged. */}
        {hoverFraction !== null ? (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-fg-3"
              style={{ left: `${hoverFraction * 100}%` }}
            />
            {previewFrame ? (
              <HoverPreview
                key={previewFrame.sha1}
                bridge={bridge}
                traceUri={model.traceUri}
                frame={previewFrame}
                label={formatTraceOffset(hoverTime ?? 0, model.startTime)}
                left={previewLeft}
                width={previewWidth}
                below={previewBelow}
              />
            ) : (
              <div
                className="pointer-events-none absolute top-0 whitespace-nowrap font-mono text-11 text-fg-3"
                style={{
                  left: `${hoverFraction * 100}%`,
                  transform:
                    hoverFraction > 0.9
                      ? "translateX(-100%)"
                      : hoverFraction < 0.1
                        ? "translateX(0)"
                        : "translateX(-50%)",
                }}
              >
                {formatTraceOffset(
                  model.startTime + hoverFraction * duration,
                  model.startTime,
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
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

function HoverPreview({
  bridge,
  traceUri,
  frame,
  label,
  left,
  width,
  below,
}: {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  label: string;
  left: number;
  width: number;
  /** Render under the strip when the viewport has no room above it. */
  below: boolean;
}): React.ReactElement {
  const { url } = useObjectUrl(bridge, sha1Path(traceUri, frame.sha1));

  return (
    <div
      className={cn(
        // z-50: when flipped below, the card overlays the workbench panes
        // (snapshot iframes, detail tabs), which come later in DOM order and
        // would otherwise paint on top of it.
        "pointer-events-none absolute z-50 rounded border border-line-1 bg-bg-0 p-1 shadow-md",
        below ? "top-full mt-2" : "bottom-full mb-2",
      )}
      style={{ left }}
    >
      <div
        className="overflow-hidden rounded-sm bg-bg-2"
        style={{ width, height: PREVIEW_HEIGHT }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            draggable={false}
            className="size-full object-cover"
          />
        ) : null}
      </div>
      <div className="mt-1 whitespace-nowrap text-center font-mono text-11 text-fg-3">
        {label}
      </div>
    </div>
  );
}

function FilmstripThumb({
  bridge,
  traceUri,
  frame,
  width,
  height,
}: {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  width: number;
  height: number;
}): React.ReactElement {
  const { url } = useObjectUrl(bridge, sha1Path(traceUri, frame.sha1));

  return (
    <div className="shrink-0 overflow-hidden bg-bg-2" style={{ width, height }}>
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : null}
    </div>
  );
}
