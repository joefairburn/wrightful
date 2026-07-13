"use client";

/**
 * Where the SW bridge document lives (inside the /trace-viewer/ service-worker
 * scope — see `bridge.html` for why the dashboard page itself must never be
 * the SW-controlled client). Single source of truth for the bridge location,
 * shared by the viewer's own bridge (`use-trace-model.ts`) and the hover
 * prewarm (`warm.ts`).
 */
export const BRIDGE_PATH = "/trace-viewer/bridge.html";

/**
 * Create + mount the hidden bridge iframe. With a `traceUrl` the bridge loads
 * and parses that trace into the SW's cache; without one it only registers
 * the service worker (warm mode). The caller owns the returned node's
 * lifetime (removal).
 */
export function mountBridgeIframe(
  traceUrl: string | undefined,
  title: string,
): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = title;
  iframe.src = traceUrl
    ? `${BRIDGE_PATH}?trace=${encodeURIComponent(traceUrl)}`
    : BRIDGE_PATH;
  document.body.appendChild(iframe);
  return iframe;
}
