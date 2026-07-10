"use client";

import { ExternalLink, ImageIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import type {
  Snapshot,
  SnapshotInfo,
  SnapshotSet,
  SnapshotTabId,
} from "../model";
import {
  collectSnapshots,
  snapshotIframeUrl,
  snapshotInfoPath,
  snapshotPopoutUrl,
  snapshotViewport,
} from "../model";
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
 * default since the repaint is best-effort and sometimes imprecise. Read
 * lazily, same pattern as action-list's `readShownGroups` — the try/catch
 * also absorbs SSR (`window` undefined during the server render pass).
 */
const CANVAS_FROM_SCREENSHOT_KEY =
  "wrightful:trace-viewer:canvas-from-screenshot";

function readCanvasFromScreenshot(): boolean {
  try {
    return window.localStorage.getItem(CANVAS_FROM_SCREENSHOT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Cache key for a snapshot's `snapshotInfo/` sidecar (page + name identify it). */
function snapshotInfoKey(snapshot: Snapshot): string {
  return `${snapshot.pageId}:${snapshot.snapshotName}`;
}

/**
 * Center pane: the DOM snapshot scrubber. Up to three iframes (Before/Action/
 * After) are mounted at once, one per available snapshot in the action's
 * `SnapshotSet`, and tab switches merely toggle which is visible — this is
 * what makes scrubbing flash-free (the old single `key={url}` iframe
 * remounted, and therefore reloaded, on every tab click). The iframe
 * navigates to the SW-rendered snapshot document
 * (`/trace-viewer/snapshot/<pageId>?…`) — a navigation request, so the SW
 * serves it even though this page itself is not SW-controlled. When the
 * selected ACTION changes the whole `SnapshotSet` (and therefore every
 * iframe's `src`) changes too, so a reload there is expected.
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
  bridge?: TraceBridge;
}): React.ReactElement {
  const snapshots: SnapshotSet = useMemo(
    () => collectSnapshots(action),
    [action],
  );
  const [tab, setTab] = useState<SnapshotTabId>("action");
  const [canvasFromScreenshot, setCanvasFromScreenshot] = useState<boolean>(
    readCanvasFromScreenshot,
  );
  const available = TAB_ORDER.filter((id) => snapshots[id]);
  const activeTab: SnapshotTabId | undefined = snapshots[tab]
    ? tab
    : (["action", "after", "before"] as const).find((id) => snapshots[id]);
  const activeSnapshot: Snapshot | undefined = activeTab
    ? snapshots[activeTab]
    : undefined;

  const info = useSnapshotInfo(bridge, traceUrl, activeSnapshot);

  const toggleCanvasFromScreenshot = (): void => {
    setCanvasFromScreenshot((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          CANVAS_FROM_SCREENSHOT_KEY,
          next ? "1" : "0",
        );
      } catch {
        /* persistence is best-effort */
      }
      return next;
    });
  };

  // Absolute URL of the currently rendered snapshot iframe, resolved against
  // the page origin for the popout shell — same client-only guard as
  // `TestReplayContent`'s `absoluteTraceUrl` (null on SSR, set on hydrate).
  const popoutHref = useMemo(() => {
    if (typeof window === "undefined" || !activeSnapshot) return undefined;
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
          <button
            type="button"
            aria-pressed={canvasFromScreenshot}
            title="Paint <canvas> content from the nearest screenshot (may be imprecise)"
            onClick={toggleCanvasFromScreenshot}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded",
              canvasFromScreenshot
                ? "bg-bg-3 text-fg-2"
                : "text-fg-4 hover:text-fg-2",
            )}
          >
            <ImageIcon className="size-3.5" />
          </button>
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
      {bridge ? <SnapshotUrlBar url={info?.url} /> : null}
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
      <span className="truncate font-mono text-12 text-fg-4" title={url}>
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
  bridge: TraceBridge | undefined,
  traceUrl: string,
  snapshot: Snapshot | undefined,
): SnapshotInfo | undefined {
  const cacheRef = useRef(new Map<string, SnapshotInfo>());
  const [entry, setEntry] = useState<{
    key: string;
    info: SnapshotInfo;
  } | null>(null);

  const key = snapshot ? snapshotInfoKey(snapshot) : undefined;

  useEffect(() => {
    if (!bridge || !snapshot || !key) return;
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
        const parsed = raw as SnapshotInfo;
        if (parsed.error) return; // sidecar failed — fall back silently
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
  /** See `readCanvasFromScreenshot` — applies to every mounted iframe's src. */
  canvasFromScreenshot: boolean;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  // One escape-binding cleanup per mounted iframe, keyed the same way as the
  // info cache. The old code kept a single cleanup ref, which only worked
  // because there was only ever one iframe; now up to three can be loaded
  // (and re-loaded, on action change) independently.
  const escapeCleanupsRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    const cleanups = escapeCleanupsRef.current;
    return () => {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: node.clientWidth, height: node.clientHeight });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
            const isActive = id === activeTab;
            const url = snapshotIframeUrl(traceUrl, snapshot, {
              populateCanvasFromScreenshot: canvasFromScreenshot,
            });
            return (
              <iframe
                // Keying on the url (not just `id`) forces a reload when the
                // selected action changes the underlying snapshot for this
                // tab slot, while leaving it mounted across tab switches.
                key={`${id}:${url}`}
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
                  if (!onEscape) return;
                  const cacheKey = snapshotInfoKey(snapshot);
                  escapeCleanupsRef.current.get(cacheKey)?.();
                  const win = e.currentTarget.contentWindow;
                  if (win) {
                    escapeCleanupsRef.current.set(
                      cacheKey,
                      bindEscapeAcrossFrames(win, onEscape),
                    );
                  } else {
                    escapeCleanupsRef.current.delete(cacheKey);
                  }
                }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
