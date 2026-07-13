"use client";

import { ExternalLink, ImageIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import type {
  ResolvedSnapshotInfo,
  Snapshot,
  SnapshotSet,
  SnapshotTabId,
} from "../model";
import {
  collectSnapshots,
  parseSnapshotInfo,
  snapshotIframeUrl,
  snapshotInfoPath,
  snapshotPopoutUrl,
  snapshotViewport,
} from "../model";
import { useElementSize } from "../use-element-size";
import { usePersistedFlag } from "../use-persisted-flag";
import type { TraceBridge } from "../use-trace-model";
import type { ActionTraceEventInContext } from "../vendor/model-util";
import { bindEscapeAcrossFrames } from "./escape-frames";

const TAB_LABELS: Record<SnapshotTabId, string> = {
  before: "Before",
  action: "Action",
  after: "After",
};
const TAB_ORDER: SnapshotTabId[] = ["before", "action", "after"];

/**
 * Persisted opt-in for repainting `<canvas>` content from the nearest
 * screencast frame (canvas pixels aren't captured in DOM snapshots — see
 * `snapshotIframeUrl`'s `populateCanvasFromScreenshot` option). Off by
 * default since the repaint is best-effort and sometimes imprecise.
 */
const CANVAS_FROM_SCREENSHOT_KEY =
  "wrightful:trace-viewer:canvas-from-screenshot";

/**
 * Cache key for a snapshot's `snapshotInfo/` sidecar. The trace URL is part
 * of the key: the pane stays mounted across an attempt swap (the workbench
 * is deliberately un-keyed — see `trace-viewer.tsx`), and page ids /
 * snapshot names recur across a test's attempts with different content.
 */
function snapshotInfoKey(traceUrl: string, snapshot: Snapshot): string {
  return `${traceUrl}#${snapshot.pageId}:${snapshot.snapshotName}`;
}

/**
 * Center pane: the DOM snapshot scrubber. Up to three iframes (Before/Action/
 * After) are mounted at once, one per available snapshot in the action's
 * `SnapshotSet`, and tab switches merely toggle which is visible — this is
 * what makes TAB switching flash-free (the old single `key={url}` iframe
 * remounted, and therefore reloaded, on every tab click). The iframe
 * navigates to the SW-rendered snapshot document
 * (`/trace-viewer/snapshot/<pageId>?…`) — a navigation request, so the SW
 * serves it even though this page itself is not SW-controlled. When the
 * selected ACTION (or, on an attempt swap, the whole trace) changes, each
 * slot NAVIGATES its existing iframe in place (`location.replace`) instead
 * of remounting it — the browser keeps the previous document painted until
 * the next one commits, so scrubbing and attempt switches never show a
 * blank iframe (see {@link SnapshotFrame}).
 */
export function SnapshotPane({
  action,
  traceUrl,
  onEscape,
  bridge,
}: {
  action: ActionTraceEventInContext | undefined;
  traceUrl: string;
  onEscape?: () => void;
  /** Bridge proxy for the `snapshotInfo/` sidecar (URL bar + exact viewport). */
  bridge: TraceBridge;
}): React.ReactElement {
  const snapshots: SnapshotSet = useMemo(
    () => collectSnapshots(action),
    [action],
  );
  const [tab, setTab] = useState<SnapshotTabId>("action");
  const [canvasFromScreenshot, setCanvasFromScreenshot] = usePersistedFlag(
    CANVAS_FROM_SCREENSHOT_KEY,
    false,
  );
  const available = TAB_ORDER.filter((id) => snapshots[id]);
  const activeTab: SnapshotTabId | undefined = snapshots[tab]
    ? tab
    : (["action", "after", "before"] as const).find((id) => snapshots[id]);
  const activeSnapshot: Snapshot | undefined = activeTab
    ? snapshots[activeTab]
    : undefined;

  const info = useSnapshotInfo(bridge, traceUrl, activeSnapshot);

  // Absolute URL of the currently rendered snapshot iframe, resolved against
  // the page origin for the popout shell. `window` is safe here: this pane
  // only ever mounts after the bridge posts a model, which requires a
  // client-side effect — it never server-renders.
  const popoutHref = useMemo(() => {
    if (!activeSnapshot) return undefined;
    const relativeUrl = snapshotIframeUrl(traceUrl, activeSnapshot, {
      populateCanvasFromScreenshot: canvasFromScreenshot,
    });
    const absoluteUrl = new URL(relativeUrl, window.location.origin).href;
    return snapshotPopoutUrl(traceUrl, absoluteUrl);
  }, [traceUrl, activeSnapshot, canvasFromScreenshot]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end justify-between gap-2 pr-2">
        <TabBar className="min-w-0 flex-1 px-2" role="tablist">
          {available.map((id) => (
            <TabBarTab
              key={id}
              active={id === activeTab}
              onSelect={() => setTab(id)}
            >
              {TAB_LABELS[id]}
            </TabBarTab>
          ))}
        </TabBar>
        <div className="mb-1 flex shrink-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-pressed={canvasFromScreenshot}
            title="Paint <canvas> content from the nearest screenshot (may be imprecise)"
            onClick={() => setCanvasFromScreenshot(!canvasFromScreenshot)}
            className={cn(canvasFromScreenshot && "bg-bg-3 text-fg-2")}
          >
            <ImageIcon />
          </Button>
          {popoutHref ? (
            <a
              href={popoutHref}
              target="_blank"
              rel="noreferrer"
              title="Open snapshot in a new tab"
              className="flex size-6 shrink-0 items-center justify-center rounded text-fg-4 hover:text-fg-2"
            >
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
      </div>
      <SnapshotUrlBar url={info?.url} />
      <div className="min-h-0 flex-1 bg-bg-2">
        {activeTab && activeSnapshot && action ? (
          <ScaledSnapshotStage
            traceUrl={traceUrl}
            snapshots={snapshots}
            available={available}
            activeTab={activeTab}
            viewport={info?.viewport ?? snapshotViewport(action)}
            onEscape={onEscape}
            canvasFromScreenshot={canvasFromScreenshot}
          />
        ) : (
          <Empty className="h-full justify-center">
            <EmptyTitle>No snapshot</EmptyTitle>
            <EmptyDescription>
              {action
                ? "This action did not capture a DOM snapshot."
                : "Select an action to see its DOM snapshot."}
            </EmptyDescription>
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * Slim "browser chrome" strip showing the page URL captured for the active
 * snapshot. Renders nothing while the URL hasn't resolved yet (no bridge, no
 * info yet, or the sidecar 404ed) so the pane doesn't jitter for a missing
 * value — an em dash reads better than a layout shift once it arrives.
 */
function SnapshotUrlBar({
  url,
}: {
  url: string | undefined;
}): React.ReactElement {
  return (
    <div className="flex h-6 shrink-0 items-center border-b border-line-1 px-3">
      <span className="truncate font-mono text-caption text-fg-4" title={url}>
        {url ?? "—"}
      </span>
    </div>
  );
}

/**
 * Resolve + cache the `snapshotInfo/` sidecar for a snapshot. Keyed by
 * `pageId:snapshotName` so re-selecting an already-visited tab is free.
 * Stale in-flight fetches (bridge/traceUrl/snapshot changed mid-request) are
 * dropped via the `cancelled` flag pattern (see `../use-object-url.ts`).
 * `info.error` (a sidecar the SW couldn't resolve) is treated as absent so
 * callers fall back to the context viewport / hide the URL bar.
 */
function useSnapshotInfo(
  bridge: TraceBridge,
  traceUrl: string,
  snapshot: Snapshot | undefined,
): ResolvedSnapshotInfo | undefined {
  const cacheRef = useRef(new Map<string, ResolvedSnapshotInfo>());
  const [entry, setEntry] = useState<{
    key: string;
    info: ResolvedSnapshotInfo;
  } | null>(null);

  const key = snapshot ? snapshotInfoKey(traceUrl, snapshot) : undefined;

  useEffect(() => {
    if (!snapshot || !key) return;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setEntry({ key, info: cached });
      return;
    }
    let cancelled = false;
    bridge
      .fetchJson(snapshotInfoPath(traceUrl, snapshot))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseSnapshotInfo(raw);
        // Malformed or error sidecar — fall back silently.
        if (!parsed || "error" in parsed) return;
        cacheRef.current.set(key, parsed);
        setEntry({ key, info: parsed });
      })
      .catch(() => {
        /* fall back to the context viewport / hidden URL bar */
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, traceUrl, snapshot, key]);

  return key && entry?.key === key ? entry.info : undefined;
}

function ScaledSnapshotStage({
  traceUrl,
  snapshots,
  available,
  activeTab,
  viewport,
  onEscape,
  canvasFromScreenshot,
}: {
  traceUrl: string;
  snapshots: SnapshotSet;
  available: SnapshotTabId[];
  activeTab: SnapshotTabId;
  viewport: { width: number; height: number };
  onEscape?: () => void;
  /** See `CANVAS_FROM_SCREENSHOT_KEY` — applies to every mounted iframe's src. */
  canvasFromScreenshot: boolean;
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
            const url = snapshotIframeUrl(traceUrl, snapshot, {
              populateCanvasFromScreenshot: canvasFromScreenshot,
            });
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
