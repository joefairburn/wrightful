"use client";

import {
  unstable_createAdapterProvider,
  type unstable_AdapterInterface,
  type unstable_AdapterOptions,
} from "nuqs/adapters/custom";
import type React from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import { navigate } from "rwsdk/client";

/**
 * Custom nuqs adapter for rwsdk.
 *
 * nuqs ships official adapters for Next, Remix, React Router, TanStack
 * Router, testing, and a browser-only React SPA adapter. The SPA adapter is
 * not SSR-safe — during rwsdk's SSR render pass it throws "nuqs requires an
 * adapter to work with your framework" because the adapter hook can't touch
 * `window.location`. This adapter does two things the SPA one doesn't:
 *
 * 1. Reads the server-side URL from a React Context populated by the RSC
 *    `Document` (see `app/document.tsx` → `Providers` → here), so SSR
 *    renders with the correct initial `searchParams`. No hydration flash
 *    for shareable URLs like `?status=failed`.
 *
 * 2. Lets callers opt in to a full RSC re-render via `shallow: false` by
 *    routing through rwsdk's `navigate()`. The default `shallow: true`
 *    just updates the URL via `history.replaceState` / `pushState`, which
 *    is what you want for client-side filter UI that already has the data
 *    in memory (the Total / Passed / Failed / Flaky tiles on the run
 *    detail page).
 */

const ServerSearchContext = createContext<string>("");

// One popstate listener, many React subscribers. Shared across all
// `useQueryState` call sites in the tree so each consumer re-renders when
// any other consumer writes the URL.
const csrListeners = new Set<() => void>();
let csrBound = false;

function csrSubscribe(listener: () => void): () => void {
  csrListeners.add(listener);
  if (!csrBound && typeof window !== "undefined") {
    window.addEventListener("popstate", csrNotify);
    csrBound = true;
  }
  return () => {
    csrListeners.delete(listener);
  };
}

function csrNotify(): void {
  for (const l of csrListeners) l();
}

function csrSnapshot(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function useAdapter(_watchKeys: string[]): unstable_AdapterInterface {
  const serverSearch = useContext(ServerSearchContext);
  const currentSearch = useSyncExternalStore(
    csrSubscribe,
    csrSnapshot,
    () => serverSearch,
  );
  const searchParams = new URLSearchParams(currentSearch);

  const updateUrl = (
    next: URLSearchParams,
    options: Required<unstable_AdapterOptions>,
  ): void => {
    if (typeof window === "undefined") return;
    const qs = next.toString();
    const url =
      (qs ? `${window.location.pathname}?${qs}` : window.location.pathname) +
      window.location.hash;
    if (options.shallow) {
      // Preserve rwsdk's `{ path, scrollX, scrollY }` in history.state so
      // scroll restoration on back/forward still works after a shallow URL
      // update. Passing `null` would wipe those fields.
      window.history[options.history === "push" ? "pushState" : "replaceState"](
        window.history.state,
        "",
        url,
      );
      csrNotify();
    } else {
      void navigate(url, { history: options.history });
    }
    if (options.scroll) window.scrollTo(0, 0);
  };

  return { searchParams, updateUrl };
}

const InnerAdapter = unstable_createAdapterProvider(useAdapter);

export function NuqsRwsdkAdapter({
  children,
  serverSearch,
}: {
  children: React.ReactNode;
  serverSearch: string;
}): React.ReactElement {
  return (
    <ServerSearchContext.Provider value={serverSearch}>
      <InnerAdapter>{children}</InnerAdapter>
    </ServerSearchContext.Provider>
  );
}
