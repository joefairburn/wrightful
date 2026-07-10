"use client";

import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SearchFilterInput } from "@/components/search-filter-input";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import { actionTitle } from "../model";
import type { ActionGroup } from "../vendor/protocol-formatter";
import type { ActionTreeItem, MultiTraceModel } from "../vendor/model-util";
import { buildActionTree, stats } from "../vendor/model-util";

/**
 * Low-signal action groups (`route` handlers, `getter` reads, context
 * `configuration` calls) are HIDDEN by default, matching the official
 * viewer's `filteredActions([])` semantics — chips per group (with counts)
 * toggle them back in. The choice persists across traces.
 */
const GROUPS: ActionGroup[] = ["route", "getter", "configuration"];
const SHOWN_GROUPS_KEY = "wrightful:trace-viewer:shown-action-groups";

/** The searchable free-text hint shown beside an action's title. */
function actionParamHint(action: ActionTreeItem["action"]): string {
  const params: Record<string, unknown> = action.params ?? {};
  if (typeof params.selector === "string") return params.selector;
  if (typeof params.url === "string") return params.url;
  if (typeof params.expression === "string") return params.expression;
  return "";
}

function readShownGroups(): ReadonlySet<ActionGroup> {
  try {
    const raw = window.localStorage.getItem(SHOWN_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(GROUPS.filter((g) => (parsed as unknown[]).includes(g)));
  } catch {
    return new Set();
  }
}

/** True if this action, or any action nested under it, failed. */
function hasErrorInSubtree(item: ActionTreeItem): boolean {
  if (item.action.error?.message) return true;
  return item.children.some((child) => hasErrorInSubtree(child));
}

/**
 * Action-tree groups start collapsed, except a group whose subtree contains
 * a failing action — that group (and every ancestor down to the failure)
 * stays expanded so the error is visible without the user having to dig
 * for it.
 */
function computeDefaultCollapsed(
  rootItem: ActionTreeItem,
): ReadonlySet<string> {
  const collapsed = new Set<string>();
  const walk = (item: ActionTreeItem): void => {
    for (const child of item.children) {
      if (child.children.length > 0 && !hasErrorInSubtree(child)) {
        collapsed.add(child.id);
      }
      walk(child);
    }
  };
  walk(rootItem);
  return collapsed;
}

/** Ancestor chain from `item`'s parent up to (excluding) the synthetic root. */
function ancestorChain(item: ActionTreeItem): ActionTreeItem[] {
  const chain: ActionTreeItem[] = [];
  for (let cur = item.parent; cur && cur.id !== ""; cur = cur.parent) {
    chain.push(cur);
  }
  return chain;
}

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
  const [shownGroups, setShownGroups] =
    useState<ReadonlySet<ActionGroup>>(readShownGroups);
  const { rootItem, itemMap } = useMemo(
    () => buildActionTree(model.filteredActions([...shownGroups])),
    [model, shownGroups],
  );
  // Groups start collapsed by default, except a subtree containing an error
  // (recomputed whenever the tree is rebuilt — new trace, new group filter).
  const defaultCollapsed = useMemo(
    () => computeDefaultCollapsed(rootItem),
    [rootItem],
  );
  // Manual toggles, keyed by item id, applied on top of the computed
  // default via XOR — this is what lets a group chip toggle (which rebuilds
  // `rootItem`/`defaultCollapsed`) preserve a user's manual expand/collapse
  // instead of snapping every group back to its default state.
  const [overrides, setOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [query, setQuery] = useState("");

  const isCollapsed = (id: string): boolean =>
    defaultCollapsed.has(id) !== overrides.has(id);

  // Auto-reveal: if selection moves (from outside — timeline seek, playback
  // stepping) to an action hidden under a collapsed ancestor, expand just
  // that ancestor chain so the row becomes visible. Never collapses
  // anything, and leaves unrelated manual collapses untouched.
  useEffect(() => {
    if (!selectedCallId) return;
    const item = itemMap.get(selectedCallId);
    if (!item) return;
    const ancestors = ancestorChain(item);
    if (ancestors.length === 0) return;
    setOverrides((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const ancestor of ancestors) {
        const effectivelyCollapsed =
          defaultCollapsed.has(ancestor.id) !== next.has(ancestor.id);
        if (!effectivelyCollapsed) continue;
        if (next.has(ancestor.id)) next.delete(ancestor.id);
        else next.add(ancestor.id);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedCallId, itemMap, defaultCollapsed]);

  const toggleGroup = (group: ActionGroup): void => {
    setShownGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        window.localStorage.setItem(
          SHOWN_GROUPS_KEY,
          JSON.stringify([...next]),
        );
      } catch {
        /* persistence is best-effort */
      }
      return next;
    });
  };

  const groupChips = GROUPS.map((group) => ({
    group,
    count: model.actionCounters.get(group) ?? 0,
  })).filter(({ count }) => count > 0);

  const toggle = (id: string): void => {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visible = useMemo(() => {
    const rows: Array<{ item: ActionTreeItem; depth: number }> = [];
    const needle = query.trim().toLowerCase();

    if (!needle) {
      const walk = (item: ActionTreeItem, depth: number): void => {
        for (const child of item.children) {
          rows.push({ item: child, depth });
          if (!isCollapsed(child.id)) walk(child, depth + 1);
        }
      };
      walk(rootItem, 0);
      return rows;
    }

    // Searching: keep matches and their ancestors, ignore collapse state so
    // a match inside a collapsed group is still reachable.
    const matches = (item: ActionTreeItem): boolean =>
      `${actionTitle(item.action)} ${actionParamHint(item.action)}`
        .toLowerCase()
        .includes(needle);
    const hasMatch = new Map<ActionTreeItem, boolean>();
    const mark = (item: ActionTreeItem): boolean => {
      let any = matches(item);
      for (const child of item.children) any = mark(child) || any;
      hasMatch.set(item, any);
      return any;
    };
    for (const child of rootItem.children) mark(child);
    const walk = (item: ActionTreeItem, depth: number): void => {
      for (const child of item.children) {
        if (!hasMatch.get(child)) continue;
        rows.push({ item: child, depth });
        walk(child, depth + 1);
      }
    };
    walk(rootItem, 0);
    return rows;
  }, [rootItem, defaultCollapsed, overrides, query]);

  const moveSelection = (delta: number): void => {
    const index = visible.findIndex(
      ({ item }) => item.action.callId === selectedCallId,
    );
    const next = visible[index + delta] ?? (index === -1 ? visible[0] : null);
    if (next) onSelect(next.item.action.callId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line-1 px-2 py-1.5">
        <SearchFilterInput
          placeholder="Filter actions"
          aria-label="Filter actions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {groupChips.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line-1 px-2 py-1.5">
          {groupChips.map(({ group, count }) => {
            const shown = shownGroups.has(group);
            return (
              <button
                key={group}
                type="button"
                aria-pressed={shown}
                title={
                  shown
                    ? `Hide ${count} ${group} action${count === 1 ? "" : "s"}`
                    : `Show ${count} ${group} action${count === 1 ? "" : "s"}`
                }
                onClick={() => toggleGroup(group)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-11 tabular-nums",
                  shown
                    ? "border-ring/40 bg-bg-3 text-fg-2"
                    : "border-line-1 text-fg-4 hover:text-fg-2",
                )}
              >
                {group} {count}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        role="listbox"
        aria-label="Actions"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
            isCollapsed={isCollapsed(item.id)}
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
