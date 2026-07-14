"use client";

import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import {
  actionIntersectsRange,
  actionParamHint,
  actionTitle,
  type TraceTimeRange,
} from "../model";
import { useModelScopedState } from "../use-model-scoped-state";
import type { ActionGroup } from "../vendor/protocol-formatter";
import type { ActionTreeItem, TraceModel } from "../vendor/model-util";
import { buildActionTree, stats } from "../vendor/model-util";

/**
 * Low-signal action groups (`route` handlers, `getter` reads, context
 * `configuration` calls) are HIDDEN by default, matching the official
 * viewer's `filteredActions([])` semantics — chips per group (with counts)
 * toggle them back in. The choice persists across traces.
 */
const GROUPS: ActionGroup[] = ["route", "getter", "configuration"];
const SHOWN_GROUPS_KEY = "wrightful:trace-viewer:shown-action-groups";

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

/**
 * Whether an item is collapsed once the computed default is XOR'd against a
 * manual override — the override toggles the default rather than replacing
 * it, which is what lets a group chip toggle (rebuilding `defaultCollapsed`)
 * preserve a user's manual expand/collapse. Shared by the row-render collapse
 * check and the auto-reveal effect (which evaluates it against an in-progress
 * override set before committing).
 */
function isEffectivelyCollapsed(
  defaultCollapsed: ReadonlySet<string>,
  overrides: ReadonlySet<string>,
  id: string,
): boolean {
  return defaultCollapsed.has(id) !== overrides.has(id);
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
  onHover,
  selection,
  onClearSelection,
}: {
  model: TraceModel;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  /** Preview-on-hover for the snapshot pane; selection is unaffected. */
  onHover?: (callId: string | undefined) => void;
  /** Timeline drag-selection: scope the list to actions in this window. */
  selection?: TraceTimeRange | null;
  /** Clears the timeline selection (the "Show all" affordance). */
  onClearSelection?: () => void;
}): React.ReactElement {
  const [shownGroups, setShownGroups] =
    useState<ReadonlySet<ActionGroup>>(readShownGroups);
  const { rootItem, itemMap } = useMemo(() => {
    const actions = model.filteredActions([...shownGroups]);
    return buildActionTree(
      selection
        ? actions.filter((a) => actionIntersectsRange(a, selection))
        : actions,
    );
  }, [model, shownGroups, selection]);
  // Groups start collapsed by default, except a subtree containing an error
  // (recomputed whenever the tree is rebuilt — new trace, new group filter).
  const defaultCollapsed = useMemo(
    () => computeDefaultCollapsed(rootItem),
    [rootItem],
  );
  // Manual toggles, keyed by callId, applied on top of the computed default via
  // XOR — this is what lets a group chip toggle (which rebuilds `rootItem`/
  // `defaultCollapsed`) preserve a user's manual expand/collapse instead of
  // snapping every group back to its default. callId restarts per trace file,
  // so these must NOT survive an attempt swap (the workbench stays mounted, see
  // trace-viewer.tsx) — `useModelScopedState` resets them on the swap, else a
  // stale `call@N` override would XOR against an unrelated group next attempt.
  const [overrides, setOverrides] = useModelScopedState<
    TraceModel,
    ReadonlySet<string>
  >(model, () => new Set());
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  const isCollapsed = (id: string): boolean =>
    isEffectivelyCollapsed(defaultCollapsed, overrides, id);

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
        const effectivelyCollapsed = isEffectivelyCollapsed(
          defaultCollapsed,
          next,
          ancestor.id,
        );
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
      {/* Borderless, full-width filter row that IS the pane's top edge — the
       * command-menu / filter-popover style (see `ComboboxFilterPopup`), not a
       * boxed field. The `h-9` wrapper carries the hairline divider, matching
       * the snapshot pane's Before/Action/After nav (`snapshot-pane.tsx`) so
       * the two panes' dividers align across the split. */}
      <div className="shrink-0 border-b border-line-1">
        <input
          type="search"
          className="h-9 w-full bg-transparent px-3 text-base outline-none placeholder:text-fg-3/72 sm:text-sm [&::-webkit-search-cancel-button]:appearance-none"
          placeholder="Filter actions"
          aria-label="Filter actions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* Timeline-selection scope bar: while a time window is drag-selected on
       * the strip, the list shows only intersecting actions and this bar is
       * the escape hatch back to the full list. */}
      {selection ? (
        <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line-1 bg-bg-2 pl-3 pr-1.5">
          <span className="truncate text-caption text-fg-3">
            Timeline selection
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className="shrink-0 rounded px-1.5 py-0.5 text-caption font-medium text-fg-2 hover:bg-bg-3"
          >
            Show all
          </button>
        </div>
      ) : null}
      {groupChips.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line-1 px-2 py-1.5">
          {groupChips.map(({ group, count }) => {
            const shown = shownGroups.has(group);
            return (
              <Tooltip key={group}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={shown}
                      onClick={() => toggleGroup(group)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-micro tabular-nums",
                        shown
                          ? "border-ring/40 bg-bg-3 text-fg-2"
                          : "border-line-1 text-fg-4 hover:text-fg-2",
                      )}
                    >
                      {group} {count}
                    </button>
                  }
                />
                <TooltipPopup>
                  {shown
                    ? `Hide ${count} ${group} action${count === 1 ? "" : "s"}`
                    : `Show ${count} ${group} action${count === 1 ? "" : "s"}`}
                </TooltipPopup>
              </Tooltip>
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
        onPointerLeave={() => onHover?.(undefined)}
      >
        {visible.map(({ item, depth }) => (
          <ActionRow
            key={item.id}
            item={item}
            depth={depth}
            startTime={model.startTime}
            selected={item.action.callId === selectedCallId}
            // While filtering, the tree is force-expanded (matches + ancestors
            // are shown regardless of collapse) and toggling is disabled, so
            // the chevron reflects that instead of the underlying override.
            isCollapsed={searching ? false : isCollapsed(item.id)}
            onToggle={searching ? undefined : toggle}
            onSelect={onSelect}
            onHover={onHover}
          />
        ))}
        {visible.length === 0 ? (
          <div className="px-3 py-6 text-center text-caption text-fg-4">
            {selection
              ? "No actions in the selected timeline range."
              : "No actions recorded in this trace."}
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
  onHover,
}: {
  item: ActionTreeItem;
  depth: number;
  startTime: number;
  selected: boolean;
  isCollapsed: boolean;
  /** Undefined disables the disclosure toggle (e.g. while filtering). */
  onToggle?: (id: string) => void;
  onSelect: (callId: string) => void;
  /** Fires synchronously on pointer enter — the snapshot pane double-buffers
   * its iframes, so a sweep across rows is safe without debouncing. */
  onHover?: (callId: string) => void;
}): React.ReactElement {
  const action = item.action;
  const failed = Boolean(action.error?.message);
  const { errors, warnings } = stats(action);
  const duration = action.endTime - action.startTime;
  const paramHint = actionParamHint(action);

  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      role="option"
      aria-selected={selected}
      data-status={failed ? "fail" : "ok"}
      ref={rowRef}
      onClick={() => {
        onSelect(action.callId);
        // Selecting a row also expands it — the chevron button handles the
        // toggle-without-select case itself via stopPropagation, so this
        // never double-toggles a chevron click.
        if (item.children.length > 0 && onToggle) onToggle(item.id);
      }}
      onPointerEnter={() => onHover?.(action.callId)}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 pr-2 text-body",
        selected ? "bg-bg-3" : "hover:bg-bg-2",
      )}
      style={{ paddingLeft: depth * 14 + 6 }}
    >
      {item.children.length > 0 && onToggle ? (
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
      ) : item.children.length > 0 ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-fg-4">
          <ChevronRight
            className={cn("size-3.5", !isCollapsed && "rotate-90")}
          />
        </span>
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
          className="min-w-0 flex-1 truncate font-mono text-caption text-fg-4"
          title={paramHint}
        >
          {paramHint}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {errors > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-micro text-fail"
          title={`${errors} console error${errors === 1 ? "" : "s"}`}
        >
          <CircleAlert className="size-3" />
          {errors}
        </span>
      ) : null}
      {warnings > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-micro text-warning"
          title={`${warnings} console warning${warnings === 1 ? "" : "s"}`}
        >
          <TriangleAlert className="size-3" />
          {warnings}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-micro text-fg-4 tabular-nums">
        {duration >= 0 ? formatDuration(Math.max(1, Math.round(duration))) : ""}
      </span>
      <span className="sr-only">
        starts at {formatDuration(Math.round(action.startTime - startTime))}
      </span>
    </div>
  );
}
