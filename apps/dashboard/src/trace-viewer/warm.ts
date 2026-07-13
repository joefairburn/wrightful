"use client";

import { mountBridgeIframe } from "./bridge-iframe";

/**
 * Pre-warm the trace viewer on intent (hover/focus of a Replay button).
 *
 * Two levels, both via hidden bridge iframes (see `bridge.html`):
 * - `warmTraceViewer()` — registers the service worker (warm mode). Mostly
 *   matters on a user's very first replay; registration persists after that.
 * - `warmTraceViewer(traceUrl)` — full prefetch: the bridge loads + parses
 *   the trace into the SW's cache, so opening the modal is near-instant.
 *
 * Each prefetch iframe pins a fully parsed trace in the SW for as long as it
 * stays mounted — and the dashboard navigates client-side, so "until the page
 * unloads" can be a whole session. At most ONE prefetch iframe therefore
 * exists at a time: warming a different trace removes the previous iframe
 * (releasing its pinned trace) before mounting the new one. Failures are
 * silent (warming is best-effort — the modal's own bridge is authoritative).
 */
let registerWarmed = false;
let prefetch: { key: string; iframe: HTMLIFrameElement } | null = null;

/**
 * Prefetch dedupe identity: the signed download token in the query rotates
 * per page load / re-mint, but it's the same trace bytes — dedupe on the
 * artifact path, not the exact signed URL.
 */
function traceKey(traceUrl: string): string {
  try {
    const url = new URL(traceUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return traceUrl;
  }
}

export function warmTraceViewer(traceUrl?: string): void {
  if (typeof document === "undefined") return;
  try {
    if (!traceUrl) {
      if (registerWarmed) return;
      registerWarmed = true;
      mountBridgeIframe(undefined, "Trace viewer warm-up");
      return;
    }
    const key = traceKey(traceUrl);
    if (prefetch?.key === key) return;
    prefetch?.iframe.remove();
    prefetch = { key, iframe: mountBridgeIframe(traceUrl, "Trace prewarm") };
  } catch {
    // Best-effort only.
  }
}
