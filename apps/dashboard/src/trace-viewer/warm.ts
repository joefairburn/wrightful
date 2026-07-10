"use client";

/**
 * Pre-warm the trace viewer on intent (hover/focus of a Replay button).
 *
 * Two levels, both via hidden bridge iframes (see `bridge.html`):
 * - `warmTraceViewer()` — registers the service worker (warm mode). Mostly
 *   matters on a user's very first replay; registration persists after that.
 * - `warmTraceViewer(traceUrl)` — full prefetch: the bridge loads + parses
 *   the trace into the SW's cache, so opening the modal is near-instant. The
 *   iframe stays mounted (it pins the SW's trace cache) until the page
 *   navigates away.
 *
 * Idempotent per URL; failures are silent (warming is best-effort — the
 * modal's own bridge is authoritative).
 */
const warmed = new Set<string>();

export function warmTraceViewer(traceUrl?: string): void {
  if (typeof document === "undefined") return;
  const src = traceUrl
    ? `/trace-viewer/bridge.html?trace=${encodeURIComponent(traceUrl)}`
    : "/trace-viewer/bridge.html";
  if (warmed.has(src)) return;
  warmed.add(src);
  try {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "Trace prewarm";
    iframe.src = src;
    document.body.appendChild(iframe);
  } catch {
    // Best-effort only.
  }
}
