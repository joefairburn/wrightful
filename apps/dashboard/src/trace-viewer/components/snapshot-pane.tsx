"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import type { Snapshot, SnapshotSet, SnapshotTabId } from "../model";
import {
  collectSnapshots,
  snapshotIframeUrl,
  snapshotViewport,
} from "../model";
import type { ActionTraceEventInContext } from "../vendor/model-util";
import { bindEscapeAcrossFrames } from "./escape-frames";

const TAB_LABELS: Record<SnapshotTabId, string> = {
  before: "Before",
  action: "Action",
  after: "After",
};
const TAB_ORDER: SnapshotTabId[] = ["before", "action", "after"];

/**
 * Center pane: the DOM snapshot scrubber. The iframe navigates to the
 * SW-rendered snapshot document (`/trace-viewer/snapshot/<pageId>?…`) — a
 * navigation request, so the SW serves it even though this page itself is
 * not SW-controlled. The document is scaled to fit while keeping the
 * recorded viewport's coordinate space (the click-pointer overlay depends
 * on it).
 */
export function SnapshotPane({
  action,
  traceUrl,
  onEscape,
}: {
  action: ActionTraceEventInContext | undefined;
  traceUrl: string;
  onEscape?: () => void;
}): React.ReactElement {
  const snapshots: SnapshotSet = useMemo(
    () => collectSnapshots(action),
    [action],
  );
  const [tab, setTab] = useState<SnapshotTabId>("action");
  const available = TAB_ORDER.filter((id) => snapshots[id]);
  const activeTab: SnapshotTabId | undefined = snapshots[tab]
    ? tab
    : (["action", "after", "before"] as const).find((id) => snapshots[id]);
  const snapshot: Snapshot | undefined = activeTab
    ? snapshots[activeTab]
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabBar className="shrink-0 px-2" role="tablist">
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
      <div className="min-h-0 flex-1 bg-bg-2">
        {snapshot && action ? (
          <ScaledSnapshotFrame
            url={snapshotIframeUrl(traceUrl, snapshot)}
            viewport={snapshotViewport(action)}
            onEscape={onEscape}
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

function ScaledSnapshotFrame({
  url,
  viewport,
  onEscape,
}: {
  url: string;
  viewport: { width: number; height: number };
  onEscape?: () => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const escapeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => escapeCleanup.current?.(), []);

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
          className={cn(
            "overflow-hidden rounded-[6px] border border-line-1 bg-white shadow-sm",
          )}
          style={{
            width: viewport.width * scale,
            height: viewport.height * scale,
          }}
        >
          <iframe
            key={url}
            title="DOM snapshot"
            src={url}
            sandbox="allow-same-origin allow-scripts"
            className="origin-top-left border-0"
            style={{
              width: viewport.width,
              height: viewport.height,
              transform: `scale(${scale})`,
            }}
            onLoad={(e) => {
              if (!onEscape) return;
              escapeCleanup.current?.();
              const win = e.currentTarget.contentWindow;
              escapeCleanup.current = win
                ? bindEscapeAcrossFrames(win, onEscape)
                : null;
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
