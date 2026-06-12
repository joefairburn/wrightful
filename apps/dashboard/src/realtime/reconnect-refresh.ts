"use client";

/**
 * Coalesced loader refresh for WS reconnects, shared by `useRunRoom` and
 * `useProjectRoom`.
 *
 * Rooms have no event replay — any broadcast missed while disconnected is gone
 * — so on a RE-open the hooks re-run the page loader (`router.refresh()`); the
 * fresh props then flow back in through the hooks' render-time reseed
 * (`useSeededState`). But one page mounts MANY live leaves on one shared room
 * socket (the run-detail page alone has ~5: status glyph, duration, tab count,
 * summary tiles, test list), and a single reconnect fires every leaf's
 * `onReconnect` — so a naive per-leaf refresh would issue ~5 identical loader
 * round-trips per drop. This module-scoped timestamp guard collapses a
 * reconnect burst (across ALL rooms on the page) to ONE refresh per window.
 */
const REFRESH_WINDOW_MS = 1000;

let lastRefreshAt = 0;

/**
 * Run `refresh` unless one already ran within the last
 * {@link REFRESH_WINDOW_MS}; later requests in the same burst are dropped (the
 * one refresh already re-fetches everything the page renders). The return
 * value (e.g. `router.refresh()`'s promise) is intentionally discarded —
 * reconciliation is best-effort; the next live event or reload is
 * authoritative.
 */
export function requestReconnectRefresh(refresh: () => unknown): void {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_WINDOW_MS) return;
  lastRefreshAt = now;
  void refresh();
}

/** Test-only: clears the burst window so each test observes its own refresh. */
export function resetReconnectRefreshForTests(): void {
  lastRefreshAt = 0;
}
