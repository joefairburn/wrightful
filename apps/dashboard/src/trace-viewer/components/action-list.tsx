"use client";

import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import { actionTitle } from "../model";
import type { ActionTreeItem, MultiTraceModel } from "../vendor/model-util";
import { buildActionTree, stats } from "../vendor/model-util";

/**
 * Left pane of the workbench: the merged test-runner/library action tree.
 * Selection is controlled by the workbench (snapshot pane + detail tabs key
 * off it).
 */
export function ActionList({
  model,
  selectedCallId,
  onSelect,
}: {
  model: MultiTraceModel;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
}): React.ReactElement {
  const rootItem = useMemo(
    () => buildActionTree(model.actions).rootItem,
    [model],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visible = useMemo(() => {
    const rows: Array<{ item: ActionTreeItem; depth: number }> = [];
    const walk = (item: ActionTreeItem, depth: number): void => {
      for (const child of item.children) {
        rows.push({ item: child, depth });
        if (!collapsed.has(child.id)) walk(child, depth + 1);
      }
    };
    walk(rootItem, 0);
    return rows;
  }, [rootItem, collapsed]);

  const moveSelection = (delta: number): void => {
    const index = visible.findIndex(
      ({ item }) => item.action.callId === selectedCallId,
    );
    const next = visible[index + delta] ?? (index === -1 ? visible[0] : null);
    if (next) onSelect(next.item.action.callId);
  };

  return (
    <div
      role="listbox"
      aria-label="Actions"
      tabIndex={0}
      className="h-full overflow-y-auto overscroll-contain py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveSelection(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveSelection(-1);
        }
      }}
    >
      {visible.map(({ item, depth }) => (
        <ActionRow
          key={item.id}
          item={item}
          depth={depth}
          startTime={model.startTime}
          selected={item.action.callId === selectedCallId}
          isCollapsed={collapsed.has(item.id)}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
      {visible.length === 0 ? (
        <div className="px-3 py-6 text-center text-12 text-fg-4">
          No actions recorded in this trace.
        </div>
      ) : null}
    </div>
  );
}

function ActionRow({
  item,
  depth,
  startTime,
  selected,
  isCollapsed,
  onToggle,
  onSelect,
}: {
  item: ActionTreeItem;
  depth: number;
  startTime: number;
  selected: boolean;
  isCollapsed: boolean;
  onToggle: (id: string) => void;
  onSelect: (callId: string) => void;
}): React.ReactElement {
  const action = item.action;
  const failed = Boolean(action.error?.message);
  const { errors, warnings } = stats(action);
  const duration = action.endTime - action.startTime;
  const params = action.params ?? {};
  const paramHint =
    typeof params.selector === "string"
      ? params.selector
      : typeof params.url === "string"
        ? params.url
        : typeof params.expression === "string"
          ? params.expression
          : "";

  return (
    <div
      role="option"
      aria-selected={selected}
      ref={(node) => {
        if (selected) node?.scrollIntoView({ block: "nearest" });
      }}
      onClick={() => onSelect(action.callId)}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 pr-2 text-13",
        selected ? "bg-bg-3" : "hover:bg-bg-2",
      )}
      style={{ paddingLeft: depth * 14 + 6 }}
    >
      {item.children.length > 0 ? (
        <button
          type="button"
          aria-label={isCollapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(item.id);
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-fg-4 hover:text-fg-2"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform",
              !isCollapsed && "rotate-90",
            )}
          />
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      {failed ? <CircleAlert className="size-3.5 shrink-0 text-fail" /> : null}
      <span
        className={cn("shrink-0", failed && "text-fail")}
        title={actionTitle(action)}
      >
        {actionTitle(action)}
      </span>
      {paramHint ? (
        <span
          className="min-w-0 flex-1 truncate font-mono text-12 text-fg-4"
          title={paramHint}
        >
          {paramHint}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {errors > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-11 text-fail"
          title={`${errors} console error${errors === 1 ? "" : "s"}`}
        >
          <CircleAlert className="size-3" />
          {errors}
        </span>
      ) : null}
      {warnings > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-11 text-warning"
          title={`${warnings} console warning${warnings === 1 ? "" : "s"}`}
        >
          <TriangleAlert className="size-3" />
          {warnings}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-11 text-fg-4 tabular-nums">
        {duration >= 0 ? formatDuration(Math.max(1, Math.round(duration))) : ""}
      </span>
      <span className="sr-only">
        starts at {formatDuration(Math.round(action.startTime - startTime))}
      </span>
    </div>
  );
}
