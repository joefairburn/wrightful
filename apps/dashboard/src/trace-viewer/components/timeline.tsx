"use client";

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import {
  actionParamHint,
  actionTitle,
  sha1Path,
  type TraceTimeRange,
} from "../model";
import { useElementSize } from "../use-element-size";
import type { TraceBridge } from "../use-trace-model";
import { useBufferedObjectUrl, useObjectUrl } from "../use-object-url";
import type { PageEntry } from "../vendor/entries";
import type { TraceModel } from "../vendor/model-util";
import {
  lowerBoundByTime,
  type PlaybackController,
  Playhead,
  type TimelineAction,
} from "./playback-controls";

/**
 * Filmstrip + click-to-seek timeline strip below the snapshot pane. The
 * playback engine itself (rAF clock, state model) and the moving Playhead live
 * in `playback-controls.tsx`, and the `usePlayback` controller is owned one
 * level up in the workbench (its prev/play/stop/next/speed cluster is rendered
 * in the snapshot pane's nav) — this file owns the strip: filmstrip sampling,
 * action bars lane, hover preview, click seeking, and drag range-selection
 * (a click seeks; a drag past a small threshold selects a time window, like
 * the official viewer's timeline selection).
 *
 * Screencast frames are served by the trace-viewer service worker under
 * `sha1/<name>?trace=…`, and that route only answers fetches from the
 * SW-CONTROLLED bridge client (see `use-trace-model.ts` / `bridge.html`) — a
 * plain `<img src="/trace-viewer/sha1/…">` from this (uncontrolled) dashboard
 * page would 404. So every thumbnail is fetched as a blob through
 * `bridge.fetchBlob` (via `useObjectUrl`) and rendered from an object URL
 * instead. Hooks can't be called in a loop, so each thumbnail image is its
 * own child component (`TraceFrameImage`).
 */

type ScreencastFrame = PageEntry["screencastFrames"][number];

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
 * Pointer travel (px) before a press turns from a click-seek into a
 * range-selection drag.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * Vertical room the hover preview card needs when rendered above the strip:
 * PREVIEW_HEIGHT + card padding + time-label row + mb-2 margin. When the
 * viewport space above the strip is smaller than this (e.g. the Timeline sits
 * at the very top of an overflow-hidden dialog), the card flips below instead.
 */
const PREVIEW_CLEARANCE = PREVIEW_HEIGHT + 40;

/** Binary search for the frame whose timestamp is closest to `t`. */
function nearestFrameIndex(frames: ScreencastFrame[], t: number): number {
  const lb = lowerBoundByTime(frames, t, (f) => f.timestamp);
  if (lb === 0) return 0;
  if (lb === frames.length) return frames.length - 1;
  return Math.abs(frames[lb - 1].timestamp - t) <=
    Math.abs(frames[lb].timestamp - t)
    ? lb - 1
    : lb;
}

/**
 * The action active at time `t`: the latest-starting action with startTime
 * <= t, falling back to the first action when `t` precedes every action.
 * Undefined only when `actions` is empty.
 */
function actionActiveAt(
  actions: TimelineAction[],
  t: number,
): TimelineAction | undefined {
  if (actions.length === 0) return undefined;
  const lb = lowerBoundByTime(actions, t, (a) => a.startTime);
  // lb is the first action starting AT OR AFTER t — an exact startTime===t
  // match is itself "active at t" and takes precedence over the last
  // strictly-earlier action.
  if (lb < actions.length && actions[lb].startTime === t) return actions[lb];
  return lb === 0 ? actions[0] : actions[lb - 1];
}

/**
 * The strip's affine geometry: the one owner of the model-time ↔ strip-fraction
 * ↔ CSS-percent maps, so every overlay and handler shares one convention
 * instead of re-deriving `start + f*dur` / `(t-start)/dur` by hand (some
 * clamped, some multiplied into a `%` string) at a dozen call sites.
 */
type TimeScale = {
  duration: number;
  /** Model-time at a 0..1 fraction of the strip. */
  timeAt: (fraction: number) => number;
  /** 0..1 fraction for a model-time; `clamp` bounds it to the strip [0,1]. */
  fractionAt: (time: number, opts?: { clamp?: boolean }) => number;
  /** 0..100 percent for a model-time (for `left`/`width` style strings). */
  percentAt: (time: number) => number;
};

function makeTimeScale(startTime: number, endTime: number): TimeScale {
  const duration = endTime - startTime;
  const fractionAt = (time: number, opts?: { clamp?: boolean }): number => {
    const f = (time - startTime) / duration;
    return opts?.clamp ? Math.min(1, Math.max(0, f)) : f;
  };
  return {
    duration,
    timeAt: (fraction) => startTime + fraction * duration,
    fractionAt,
    percentAt: (time) => fractionAt(time) * 100,
  };
}

export function Timeline({
  model,
  bridge,
  selectedCallId,
  onSelect,
  playback,
  playableActions,
  seekActions,
  selection,
  onSelectionChange,
  className,
}: {
  model: TraceModel;
  bridge: TraceBridge;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  /** Shared playback controller (owned by the workbench). */
  playback: PlaybackController;
  /**
   * The action set the moving Playhead walks — the default-visible set,
   * pre-filtered by the workbench to the `selection` window while one is
   * active (shared with the snapshot pane's control cluster).
   */
  playableActions: TimelineAction[];
  /**
   * The FULL default-visible set, ignoring any selection window — what
   * click-seeks and hover captions resolve against. A click clears the
   * selection and lands on the action at that exact point, so it must never
   * be clamped to the window; identical to `playableActions` when no
   * selection is active.
   */
  seekActions: TimelineAction[];
  /**
   * The drag-selected time window, owned by the workbench (the action list
   * scopes to it and clears it via "Show all").
   */
  selection: TraceTimeRange | null;
  /**
   * Fires continuously while a selection drag is in progress, and with
   * `null` when a plain click (no drag) dismisses the active selection.
   */
  onSelectionChange: (range: TraceTimeRange | null) => void;
  className?: string;
}): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementSize(containerRef)?.width ?? 0;

  const scale = useMemo(
    () => makeTimeScale(model.startTime, model.endTime),
    [model.startTime, model.endTime],
  );

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
    if (slotCount === 0 || scale.duration <= 0) return [];
    const result: ScreencastFrame[] = [];
    for (let i = 0; i < slotCount; i++) {
      const t = scale.timeAt((i + 0.5) / slotCount);
      result.push(allFrames[nearestFrameIndex(allFrames, t)]);
    }
    return result;
  }, [allFrames, slotCount, scale]);

  const selectedAction = useMemo(
    () => model.actions.find((a) => a.callId === selectedCallId),
    [model, selectedCallId],
  );

  // A hover session is fraction (moves every pointermove) + below (whether
  // the preview card flips under the strip) — `below` only changes with the
  // Timeline's position in the viewport, which doesn't move mid-hover, so
  // it's resolved once per session instead of on every pointermove.
  const [hover, setHover] = useState<{
    fraction: number;
    below: boolean;
  } | null>(null);
  // A press starts as a click-seek; once the pointer travels past
  // DRAG_THRESHOLD_PX it becomes a range-selection drag anchored at the
  // press position (`selecting` latches — a drag never turns back into a
  // click even if the pointer returns to the anchor).
  const draggingRef = useRef<{
    anchorClientX: number;
    anchorFraction: number;
    selecting: boolean;
  } | null>(null);

  // The bars lane below renders every action; the workbench provides the
  // sets playback (`playableActions`) and seeking (`seekActions`) walk.
  if (scale.duration <= 0) return null;

  const fractionAtClientX = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToFraction = (fraction: number): void => {
    // actionActiveAt only returns undefined for an empty action list — guard
    // that once here instead of a per-call `if (action)` on every seek.
    if (seekActions.length === 0) return;
    const t = scale.timeAt(fraction);
    onSelect(actionActiveAt(seekActions, t)!.callId);
  };

  const previewBelow = (): boolean => {
    // The Timeline can sit at the very top of an overflow-hidden dialog, in
    // which case an above-the-strip preview card would be clipped — measure
    // the viewport space above and flip the card below when it won't fit.
    const top = containerRef.current?.getBoundingClientRect().top ?? 0;
    return top < PREVIEW_CLEARANCE;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const fraction = fractionAtClientX(event.clientX);
    draggingRef.current = {
      anchorClientX: event.clientX,
      anchorFraction: fraction,
      selecting: false,
    };
    // Manual seeking takes over from playback.
    playback.pause();
    setHover((prev) => ({ fraction, below: prev?.below ?? previewBelow() }));
    seekToFraction(fraction);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const fraction = fractionAtClientX(event.clientX);
    setHover((prev) =>
      prev
        ? { fraction, below: prev.below }
        : { fraction, below: previewBelow() },
    );
    const drag = draggingRef.current;
    if (!drag) return;
    if (
      !drag.selecting &&
      Math.abs(event.clientX - drag.anchorClientX) > DRAG_THRESHOLD_PX
    ) {
      drag.selecting = true;
    }
    if (drag.selecting) {
      const a = scale.timeAt(drag.anchorFraction);
      const b = scale.timeAt(fraction);
      onSelectionChange({ start: Math.min(a, b), end: Math.max(a, b) });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    // A press that never turned into a drag is a plain click: it already
    // seeked on pointerdown (against the full `seekActions` set), and it also
    // dismisses any active selection window. Read the drag state BEFORE
    // releasing capture — releasing fires lostpointercapture, which nulls it.
    const drag = draggingRef.current;
    if (drag && !drag.selecting && selection) onSelectionChange(null);
    // Drag state is cleared in onLostPointerCapture (below), which fires for
    // this release AND for a pointercancel (e.g. a touch turning into a scroll)
    // where onPointerUp never runs — leaving draggingRef stuck otherwise.
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const selectedStartFraction = selectedAction
    ? scale.fractionAt(selectedAction.startTime)
    : null;
  const selectedEndFraction = selectedAction
    ? scale.fractionAt(selectedAction.endTime)
    : null;

  const selectionStartFraction = selection
    ? scale.fractionAt(selection.start, { clamp: true })
    : null;
  const selectionEndFraction = selection
    ? scale.fractionAt(selection.end, { clamp: true })
    : null;

  // The frame nearest the hovered TIME (not a slot sample) drives the hover
  // preview card. Keying/fetching by its sha1 means the card only refetches
  // when the cursor actually crosses into a new frame's window.
  const hoverFraction = hover?.fraction ?? null;
  const hoverTime = hoverFraction !== null ? scale.timeAt(hoverFraction) : null;
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

  // The action the click would land on at the hovered time — shown as the
  // title + selector caption under the preview card, matching the official
  // viewer. Same set (and same `actionActiveAt`) as `seekToFraction`, so the
  // caption always names the action a click would actually select.
  const hoverAction =
    hoverTime !== null && seekActions.length > 0
      ? actionActiveAt(seekActions, hoverTime)
      : undefined;

  return (
    <div
      className={cn("flex w-full select-none", className)}
      style={{ height: TOTAL_HEIGHT }}
    >
      <div
        ref={containerRef}
        data-testid="timeline-strip"
        className="relative min-w-0 flex-1 cursor-crosshair"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onLostPointerCapture={() => {
          draggingRef.current = null;
        }}
        onPointerLeave={() => {
          if (!draggingRef.current) setHover(null);
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
            const left = scale.percentAt(action.startTime);
            const width = (span / scale.duration) * 100;
            return (
              <div
                key={action.callId}
                data-testid="timeline-bar"
                data-status={action.error ? "fail" : "ok"}
                data-selected={isSelected ? "true" : "false"}
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
         * screencast frames — click-to-seek still works either way.
         *
         * Slots are keyed by INDEX, not sha1: an attempt swap replaces the
         * whole trace model in place (the workbench stays mounted — see
         * `trace-viewer.tsx`), so every slot's frame gets a new sha1 at once.
         * Keying by sha1 would remount every `TraceFrameImage`, and
         * `keepPrevious` (below) only holds a previous object URL across
         * *its own* re-render — it can't survive a remount. Keying by slot
         * index instead reuses the same component instances, so
         * `keepPrevious` can keep each slot showing the outgoing attempt's
         * thumbnail until its replacement blob resolves. */}
        <div
          className="absolute inset-x-0 bottom-0 flex overflow-hidden bg-bg-2"
          style={{ height: STRIP_HEIGHT }}
        >
          {slots.map((frame, i) => (
            <BufferedTraceFrameImage
              key={i}
              bridge={bridge}
              traceUri={model.traceUri}
              frame={frame}
              width={thumbWidth}
              height={STRIP_HEIGHT}
              className="shrink-0"
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

        {/* Drag-selected time window: everything OUTSIDE the window is
         * shrouded (the window itself stays clear so the filmstrip reads
         * through it), with hairline edges marking the bounds — the official
         * viewer's timeline-selection treatment. */}
        {selectionStartFraction !== null && selectionEndFraction !== null ? (
          <div
            data-testid="timeline-selection"
            className="pointer-events-none absolute inset-0"
          >
            <div
              className="absolute inset-y-0 left-0 bg-bg-0/60"
              style={{ width: `${selectionStartFraction * 100}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-bg-0/60"
              style={{ width: `${(1 - selectionEndFraction) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 border-x border-fg-3"
              style={{
                left: `${selectionStartFraction * 100}%`,
                width: `${Math.max(0, selectionEndFraction - selectionStartFraction) * 100}%`,
              }}
            />
          </div>
        ) : null}

        {/* Moving playhead while replaying — distinct from the hover cursor.
         * Owns its own rAF loop (see playback-controls.tsx); remounted via
         * `key` each time a play session starts. */}
        {playback.playing ? (
          <Playhead
            key={playback.session}
            startTime={playback.playFrom}
            stopTime={playback.playTo}
            traceStartTime={model.startTime}
            traceEndTime={model.endTime}
            speedIndex={playback.speedIndex}
            playableActions={playableActions}
            initialSelectedCallId={playback.initialSelectedCallId}
            onSelect={onSelect}
            onComplete={playback.pause}
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
                below={hover?.below ?? false}
                bridge={bridge}
                traceUri={model.traceUri}
                frame={previewFrame}
                label={formatTraceOffset(hoverTime ?? 0, model.startTime)}
                title={hoverAction ? actionTitle(hoverAction) : undefined}
                hint={hoverAction ? actionParamHint(hoverAction) : undefined}
                left={previewLeft}
                width={previewWidth}
              />
            ) : (
              <div
                className="pointer-events-none absolute top-0 whitespace-nowrap font-mono text-micro text-fg-3"
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
                  scale.timeAt(hoverFraction),
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

function HoverPreview({
  bridge,
  traceUri,
  frame,
  label,
  title,
  hint,
  left,
  width,
  below,
}: {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  label: string;
  /** The action active at the hovered time (e.g. `Expect "toBeVisible"`). */
  title?: string;
  /** That action's selector/url/expression, dimmed under the title. */
  hint?: string;
  left: number;
  width: number;
  /** Render under the strip when the viewport has no room above it. */
  below: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid="timeline-preview"
      data-side={below ? "bottom" : "top"}
      className={cn(
        // z-50: when flipped below, the card overlays the workbench panes
        // (snapshot iframes, detail tabs), which come later in DOM order and
        // would otherwise paint on top of it.
        "pointer-events-none absolute z-50 rounded border border-line-1 bg-bg-0 p-1 shadow-md",
        below ? "top-full mt-2" : "bottom-full mb-2",
      )}
      style={{ left }}
    >
      <TraceFrameImage
        bridge={bridge}
        traceUri={traceUri}
        frame={frame}
        width={width}
        height={PREVIEW_HEIGHT}
        className="rounded-sm"
      />
      {/* Action caption — title over its selector — mirrors the official
       * viewer's hover popover. Constrained to the frame width so a long
       * selector truncates instead of stretching the card. */}
      {title ? (
        <div className="mt-1 px-0.5" style={{ width }}>
          <div className="truncate text-caption text-fg-2" title={title}>
            {title}
          </div>
          {hint ? (
            <div
              className="truncate font-mono text-micro text-fg-4"
              title={hint}
            >
              {hint}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1 whitespace-nowrap text-center font-mono text-micro text-fg-3">
        {label}
      </div>
    </div>
  );
}

/**
 * A single screencast frame, fetched as a blob through the bridge and
 * rendered from an object URL. Shared by the filmstrip row and the hover
 * preview card — both are just a sized, overflow-hidden, object-cover box.
 */
type TraceFrameImageProps = {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  width: number;
  height: number;
  className?: string;
};

/** Presentational box: a sized, overflow-hidden, object-cover frame image (or
 * an empty box while the object URL resolves). */
function FrameImageBox({
  url,
  width,
  height,
  className,
}: {
  url: string | null;
  width: number;
  height: number;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn("overflow-hidden bg-bg-2", className)}
      style={{ width, height }}
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
  );
}

/** The hover-preview frame: keyed by sha1 per hover, so a plain object URL that
 * blanks between frames is fine. */
function TraceFrameImage({
  bridge,
  traceUri,
  frame,
  ...box
}: TraceFrameImageProps): React.ReactElement {
  const { url } = useObjectUrl(bridge, sha1Path(traceUri, frame.sha1));
  return <FrameImageBox url={url} {...box} />;
}

/** The filmstrip frame: slots are keyed by index and outlive an attempt swap,
 * so each keeps showing the outgoing frame until the new one loads (buffered)
 * instead of blanking the whole strip mid-swap. */
function BufferedTraceFrameImage({
  bridge,
  traceUri,
  frame,
  ...box
}: TraceFrameImageProps): React.ReactElement {
  const { url } = useBufferedObjectUrl(bridge, sha1Path(traceUri, frame.sha1));
  return <FrameImageBox url={url} {...box} />;
}
