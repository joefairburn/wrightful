"use client";

import { type Dispatch, type SetStateAction, useState } from "react";

/** Element-wise reference comparison, exactly like React's effect deps. */
function depsChanged(
  prev: readonly unknown[],
  next: readonly unknown[],
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * `useState` that re-seeds itself when `deps` change — the render-time
 * "adjusting state when props change" pattern, shared by the room hooks
 * (`useRunRoom` / `useProjectRoom`).
 *
 * Void renders page components UNKEYED across SPA navigations, so navigating
 * run A → run B (or changing runs-list filters) re-renders the same mounted
 * component with new loader props. The hook tracks the seed identity (`deps`,
 * compared element-wise by reference like React deps — loader props get fresh
 * identities per navigation) and, when it changes during render, resets the
 * state from `seed()` before React re-renders children (no committed frame of
 * stale state, no effect round-trip).
 *
 * IMPORTANT: every dep must be referentially STABLE across re-renders of the
 * same page instance — pass loader props through, or memoize derived objects
 * on a loader prop (see the run-detail page's `initialSummary`). An object
 * literal rebuilt every render would reseed (and re-render) in a loop.
 */
export function useSeededState<S>(
  deps: readonly unknown[],
  seed: () => S,
): [S, Dispatch<SetStateAction<S>>] {
  const [state, setState] = useState<S>(seed);
  const [prevDeps, setPrevDeps] = useState<readonly unknown[]>(deps);
  if (depsChanged(prevDeps, deps)) {
    setPrevDeps(deps);
    setState(seed());
  }
  return [state, setState];
}
