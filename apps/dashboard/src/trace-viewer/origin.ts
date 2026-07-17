/**
 * Trace snapshots may be isolated on a cookieless origin. Same-origin
 * snapshots keep scripts disabled because uploaded trace bytes are untrusted.
 * See SELF-HOSTING.md for deployment requirements.
 */

/** The trace-viewer scope path, relative to whichever origin serves it. */
export const TRACE_VIEWER_SCOPE = "/trace-viewer/";

/** Configured trace-viewer origin, or an empty string for same-origin mode. */
export function traceViewerOrigin(): string {
  const value = import.meta.env?.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN;
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

/** True when the trace viewer is served from a DIFFERENT (cookieless) origin. */
export function isSeparateTraceViewerOrigin(): boolean {
  return traceViewerOrigin() !== "";
}

export function traceViewerScopeUrl(): string {
  return `${traceViewerOrigin()}${TRACE_VIEWER_SCOPE}`;
}

/** Origin used for bridge postMessage targets and sender validation. */
export function traceViewerBridgeOrigin(pageOrigin: string): string {
  return traceViewerOrigin() || pageOrigin;
}

/** Enable snapshot scripts only when the viewer is isolated from the session. */
export function snapshotSandbox(): string {
  return isSeparateTraceViewerOrigin()
    ? "allow-same-origin allow-scripts"
    : "allow-same-origin";
}
