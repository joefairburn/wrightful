"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { snapshotIframeUrl } from "../model";
import type { SnapshotSet, SnapshotTabId } from "../model";
import { useElementSize } from "../use-element-size";
import { bindEscapeAcrossFrames } from "./escape-frames";

export const TAB_LABELS: Record<SnapshotTabId, string> = {
  before: "Before",
  action: "Action",
  after: "After",
};

/**
 * The DOM-snapshot iframe stage: scales the recorded viewport to fit the pane
 * and double-buffers the swap so scrubbing/attempt switches never flash a blank
 * iframe. A self-contained subsystem — its only inputs are the action's
 * `SnapshotSet` + the active tab — split out of `SnapshotPane` so the pane's
 * tab/nav chrome and this iframe state machine can be read independently.
 */
export function ScaledSnapshotStage({
  traceUrl,
  snapshots,
  available,
  activeTab,
  viewport,
  onEscape,
}: {
  traceUrl: string;
  snapshots: SnapshotSet;
  available: SnapshotTabId[];
  activeTab: SnapshotTabId;
  viewport: { width: number; height: number };
  onEscape?: () => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);

  const PADDING = 16;
  const scale = size
    ? Math.min(
        (size.width - PADDING) / viewport.width,
        (size.height - PADDING) / viewport.height,
        1,
      )
    : 0;

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center overflow-hidden"
    >
      {size && scale > 0 ? (
        <div
          className="relative overflow-hidden rounded-[6px] border border-line-1 bg-white shadow-sm"
          style={{
            width: viewport.width * scale,
            height: viewport.height * scale,
          }}
        >
          {available.map((id) => {
            const snapshot = snapshots[id];
            if (!snapshot) return null;
            const url = snapshotIframeUrl(traceUrl, snapshot);
            return (
              <BufferedSnapshotFrame
                key={id}
                id={id}
                url={url}
                isActive={id === activeTab}
                viewport={viewport}
                scale={scale}
                onEscape={onEscape}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Double-buffers one tab slot's snapshot document. When the slot's target
 * `url` changes (scrubbing to another action, or an attempt swap replacing
 * the whole trace), the PREVIOUS document stays visible while the next one
 * loads in a hidden sibling iframe; the loaded frame is then promoted in
 * place — so the pane never shows a blank iframe mid-load. Frames are keyed
 * by URL: promotion keeps the already-loaded element's key (no remount, no
 * reload), while the retired front unmounts (running its escape-binding
 * cleanup). A target that changes again mid-load replaces the back buffer
 * (it's hidden, so its reload costs nothing visually), and a target that
 * returns to the visible document just drops the back buffer.
 */
function BufferedSnapshotFrame({
  id,
  url,
  isActive,
  viewport,
  scale,
  onEscape,
}: {
  id: SnapshotTabId;
  url: string;
  isActive: boolean;
  viewport: { width: number; height: number };
  scale: number;
  onEscape?: () => void;
}): React.ReactElement {
  const [buffer, setBuffer] = useState<{
    front: string;
    back: string | null;
  }>({ front: url, back: null });

  // Route a new target into the back buffer (render-time adjustment, so the
  // front frame is never unmounted first — React re-renders immediately and
  // discards this pass's output).
  if (url === buffer.front) {
    if (buffer.back !== null) setBuffer({ front: buffer.front, back: null });
  } else if (url !== buffer.back) {
    setBuffer({ front: buffer.front, back: url });
  }

  const promote = (): void => {
    setBuffer((prev) =>
      prev.back !== null ? { front: prev.back, back: null } : prev,
    );
  };

  const frames =
    buffer.back !== null && buffer.back !== buffer.front
      ? [
          { url: buffer.front, isFront: true },
          { url: buffer.back, isFront: false },
        ]
      : [{ url: buffer.front, isFront: true }];

  return (
    <>
      {frames.map((frame) => (
        <SnapshotFrame
          key={`${id}:${frame.url}`}
          id={id}
          url={frame.url}
          isActive={isActive && frame.isFront}
          viewport={viewport}
          scale={scale}
          onEscape={onEscape}
          onLoaded={frame.isFront ? undefined : promote}
        />
      ))}
    </>
  );
}

/**
 * One mounted snapshot iframe. Owns its own escape binding: (re-)bound in
 * `onLoad`, released on unmount and before every re-bind. Because the parent
 * keys each `SnapshotFrame` by `${id}:${url}`, a snapshot change or tab-slot
 * change unmounts the old frame outright — its cleanup effect runs then, so
 * there's no need for a manually keyed cleanup map spanning frames.
 */
function SnapshotFrame({
  id,
  url,
  isActive,
  viewport,
  scale,
  onEscape,
  onLoaded,
}: {
  id: SnapshotTabId;
  url: string;
  isActive: boolean;
  viewport: { width: number; height: number };
  scale: number;
  onEscape?: () => void;
  /** Fires after the document loads (back-buffer promotion hook). */
  onLoaded?: () => void;
}): React.ReactElement {
  const escapeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      escapeCleanupRef.current?.();
      escapeCleanupRef.current = null;
    };
  }, []);

  return (
    <iframe
      title={`DOM snapshot (${TAB_LABELS[id]})`}
      src={url}
      sandbox="allow-same-origin allow-scripts"
      aria-hidden={!isActive}
      inert={!isActive}
      className={cn(
        "absolute inset-0 origin-top-left border-0",
        isActive ? "visible" : "invisible pointer-events-none",
      )}
      style={{
        width: viewport.width,
        height: viewport.height,
        transform: `scale(${scale})`,
      }}
      onLoad={(e) => {
        escapeCleanupRef.current?.();
        escapeCleanupRef.current = null;
        if (onEscape) {
          const win = e.currentTarget.contentWindow;
          if (win) {
            escapeCleanupRef.current = bindEscapeAcrossFrames(win, onEscape);
          }
        }
        onLoaded?.();
      }}
    />
  );
}
