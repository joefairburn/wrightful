"use client";

import { useEffect, useMemo } from "react";
import { actionParamHint, actionTitle } from "./model";
import { useModelScopedState } from "./use-model-scoped-state";
import type { ActionTreeItem, TraceModel } from "./vendor/model-util";

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

export type ActionTreeRow = { item: ActionTreeItem; depth: number };

/**
 * The action tree's collapse/visibility state machine, extracted whole from
 * `ActionList` so its interlocking pieces — the error-aware default, the manual
 * XOR override set (model-scoped so it resets on an attempt swap), the
 * auto-reveal of a selected row's collapsed ancestors, and the flattened
 * visible-row walk — live in one scope with one name.
 *
 * `visibleRows` is the flattened, depth-tagged row list the list renders: the
 * collapse-respecting walk normally, or (while `query` is non-empty) a
 * matches-and-ancestors walk that ignores collapse so a match inside a
 * collapsed group stays reachable. Computed here — beside `isCollapsed` — so
 * the walk and the collapse check can't drift out of one dependency set.
 */
export function useActionTreeCollapse({
  rootItem,
  itemMap,
  model,
  selectedCallId,
  query,
}: {
  rootItem: ActionTreeItem;
  itemMap: Map<string, ActionTreeItem>;
  model: TraceModel;
  selectedCallId: string | undefined;
  query: string;
}): {
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  visibleRows: ActionTreeRow[];
} {
  // Groups start collapsed by default, except a subtree containing an error
  // (recomputed whenever the tree is rebuilt — new trace, new group filter).
  const defaultCollapsed = useMemo(
    () => computeDefaultCollapsed(rootItem),
    [rootItem],
  );
  // Manual toggles, keyed by callId, applied on top of the computed default via
  // XOR — this is what lets a group chip toggle (which rebuilds `rootItem`/
  // `defaultCollapsed`) preserve a user's manual expand/collapse. callId
  // restarts per trace file, so these must NOT survive an attempt swap (the
  // workbench stays mounted, see trace-viewer.tsx) — `useModelScopedState`
  // resets them on the swap, else a stale `call@N` override would XOR against
  // an unrelated group next attempt.
  const [overrides, setOverrides] = useModelScopedState<
    TraceModel,
    ReadonlySet<string>
  >(model, () => new Set());

  const isCollapsed = (id: string): boolean =>
    isEffectivelyCollapsed(defaultCollapsed, overrides, id);

  // Auto-reveal: if selection moves (from outside — timeline seek, playback
  // stepping) to an action hidden under a collapsed ancestor, expand just
  // that ancestor chain so the row becomes visible. Never collapses anything,
  // and leaves unrelated manual collapses untouched.
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
  }, [selectedCallId, itemMap, defaultCollapsed, setOverrides]);

  const toggle = (id: string): void => {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visibleRows = useMemo(() => {
    const rows: ActionTreeRow[] = [];
    const needle = query.trim().toLowerCase();

    if (!needle) {
      const walk = (item: ActionTreeItem, depth: number): void => {
        for (const child of item.children) {
          rows.push({ item: child, depth });
          if (!isEffectivelyCollapsed(defaultCollapsed, overrides, child.id)) {
            walk(child, depth + 1);
          }
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

  return { isCollapsed, toggle, visibleRows };
}
