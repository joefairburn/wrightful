"use client";

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import { actionParamHint, actionTitle, sha1Path } from "../model";
import { useElementSize } from "../use-element-size";
import type { TraceBridge } from "../use-trace-model";
import { useObjectUrl } from "../use-object-url";
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
 * action bars lane, hover preview, and click/drag seeking.
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

export function Timeline({
  model,
  bridge,
  selectedCallId,
  onSelect,
  playback,
  playableActions,
  className,
}: {
  model: TraceModel;
  bridge: TraceBridge;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  /** Shared playback controller (owned by the workbench). */
  playback: PlaybackController;
  /**
   * The default-visible action set playback + seeking walk — computed once in
   * the workbench and shared with the snapshot pane's control cluster.
   */
  playableActions: TimelineAction[];
  className?: string;
}): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementSize(containerRef)?.width ?? 0;

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

  // A hover session is fraction (moves every pointermove) + below (whether
  // the preview card flips under the strip) — `below` only changes with the
  // Timeline's position in the viewport, which doesn't move mid-hover, so
  // it's resolved once per session instead of on every pointermove.
  const [hover, setHover] = useState<{
    fraction: number;
    below: boolean;
  } | null>(null);
  const draggingRef = useRef(false);

  // The bars lane below renders every action; `playableActions` (the
  // default-visible set that playback + seeking walk) is provided by the
  // workbench.
  if (duration <= 0) return null;

  const fractionAtClientX = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToFraction = (fraction: number): void => {
    // actionActiveAt only returns undefined for an empty action list — guard
    // that once here instead of a per-call `if (action)` on every seek.
    if (playableActions.length === 0) return;
    const t = model.startTime + fraction * duration;
    onSelect(actionActiveAt(playableActions, t)!.callId);
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
    draggingRef.current = true;
    // Manual seeking takes over from playback.
    playback.pause();
    const fraction = fractionAtClientX(event.clientX);
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
    if (draggingRef.current) seekToFraction(fraction);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Drag state is cleared in onLostPointerCapture (below), which fires for
    // this release AND for a pointercancel (e.g. a touch turning into a scroll)
    // where onPointerUp never runs — leaving draggingRef stuck otherwise.
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
  const hoverFraction = hover?.fraction ?? null;
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

  // The action the click would land on at the hovered time — shown as the
  // title + selector caption under the preview card, matching the official
  // viewer. Same set (and same `actionActiveAt`) as `seekToFraction`, so the
  // caption always names the action a click would actually select.
  const hoverAction =
    hoverTime !== null && playableActions.length > 0
      ? actionActiveAt(playableActions, hoverTime)
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
          draggingRef.current = false;
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
            const left =
              ((action.startTime - model.startTime) / duration) * 100;
            const width = (span / duration) * 100;
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
            <TraceFrameImage
              key={i}
              bridge={bridge}
              traceUri={model.traceUri}
              frame={frame}
              width={thumbWidth}
              height={STRIP_HEIGHT}
              className="shrink-0"
              keepPrevious
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

        {/* Moving playhead while replaying — distinct from the hover cursor.
         * Owns its own rAF loop (see playback-controls.tsx); remounted via
         * `key` each time a play session starts. */}
        {playback.playing ? (
          <Playhead
            key={playback.session}
            startTime={playback.playFrom}
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
function TraceFrameImage({
  bridge,
  traceUri,
  frame,
  width,
  height,
  className,
  keepPrevious,
}: {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  width: number;
  height: number;
  className?: string;
  /**
   * Keep showing the previously resolved frame in this slot until the new
   * one loads, instead of going blank — see `useObjectUrl`'s `keepPrevious`
   * option. Used by the filmstrip row (slots are keyed by index and outlive
   * an attempt swap); the hover-preview card is keyed by sha1 per hover and
   * leaves this off.
   */
  keepPrevious?: boolean;
}): React.ReactElement {
  const { url } = useObjectUrl(bridge, sha1Path(traceUri, frame.sha1), {
    keepPrevious,
  });

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
