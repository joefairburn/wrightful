"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import { sha1Path } from "../model";
import type { TraceBridge } from "../use-trace-model";
import { useObjectUrl } from "../use-object-url";
import type { PageEntry } from "../vendor/entries";
import type { MultiTraceModel } from "../vendor/model-util";

/**
 * Filmstrip + click-to-seek timeline strip below the snapshot pane.
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
const PREVIEW_HEIGHT = 140;

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

/** The action active at time `t`: the latest-starting action with startTime <= t. */
function actionActiveAt(
  model: MultiTraceModel,
  t: number,
): MultiTraceModel["actions"][number] | undefined {
  let candidate: MultiTraceModel["actions"][number] | undefined;
  for (const action of model.actions) {
    if (action.startTime <= t) {
      if (!candidate || action.startTime > candidate.startTime) {
        candidate = action;
      }
    }
  }
  return candidate ?? model.actions[0];
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
  const draggingRef = useRef(false);

  if (duration <= 0) return null;

  const fractionAtClientX = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToFraction = (fraction: number): void => {
    const t = model.startTime + fraction * duration;
    const action = actionActiveAt(model, t);
    if (action) onSelect(action.callId);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    const fraction = fractionAtClientX(event.clientX);
    setHoverFraction(fraction);
    seekToFraction(fraction);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const fraction = fractionAtClientX(event.clientX);
    setHoverFraction(fraction);
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

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full cursor-crosshair select-none", className)}
      style={{ height: TOTAL_HEIGHT }}
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
          const left = ((action.startTime - model.startTime) / duration) * 100;
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
  );
}

function HoverPreview({
  bridge,
  traceUri,
  frame,
  label,
  left,
  width,
}: {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  label: string;
  left: number;
  width: number;
}): React.ReactElement {
  const { url } = useObjectUrl(bridge, sha1Path(traceUri, frame.sha1));

  return (
    <div
      className="pointer-events-none absolute bottom-full mb-2 rounded border border-line-1 bg-bg-0 p-1 shadow-md"
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
