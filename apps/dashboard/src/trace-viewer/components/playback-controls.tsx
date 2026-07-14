"use client";

import { ChevronLeft, ChevronRight, Pause, Play, Square } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { SPEEDS } from "./use-playback";

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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="flex size-6 shrink-0 items-center justify-center rounded text-fg-3 transition-colors hover:bg-bg-2 hover:text-fg-2 disabled:pointer-events-none disabled:opacity-40"
          >
            {children}
          </button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
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
  atStart,
  atEnd,
  speedIndex,
  onTogglePlay,
  onStop,
  onStep,
  onCycleSpeed,
}: {
  playing: boolean;
  hasActions: boolean;
  atStart: boolean;
  atEnd: boolean;
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
        disabled={atStart}
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
        disabled={!hasActions || (atStart && !playing)}
        onClick={onStop}
      >
        <Square className="size-3 fill-current" />
      </PlaybackButton>
      <PlaybackButton
        label="Next action"
        disabled={!hasActions || atEnd}
        onClick={() => onStep(1)}
      >
        <ChevronRight className="size-3.5" />
      </PlaybackButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Playback speed"
              onClick={onCycleSpeed}
              className="flex h-6 min-w-8 items-center justify-center rounded px-1 font-mono text-micro text-fg-3 tabular-nums transition-colors hover:bg-bg-2 hover:text-fg-2"
            >
              {SPEEDS[speedIndex]}×
            </button>
          }
        />
        <TooltipPopup>Playback speed</TooltipPopup>
      </Tooltip>
    </div>
  );
}
