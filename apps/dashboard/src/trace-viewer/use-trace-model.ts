"use client";

import { useEffect, useState } from "react";
import type { ContextEntry } from "./vendor/entries";

/**
 * Where the SW bridge document lives (inside the /trace-viewer/ service-worker
 * scope — see `bridge.html` for why the dashboard page itself must never be
 * the SW-controlled client).
 */
const BRIDGE_PATH = "/trace-viewer/bridge.html";

/** Bail out if the bridge never reports back (SW blocked, bundle missing…). */
const BRIDGE_TIMEOUT_MS = 30_000;

export type TraceModelState =
  | { status: "loading"; progress: { done: number; total: number } | null }
  | { status: "error"; error: string }
  | { status: "ready"; contextEntries: ContextEntry[] };

type BridgeMessage =
  | { method: "progress"; params: { done: number; total: number } }
  | { method: "model"; params: { contextEntries: ContextEntry[] } }
  | { method: "error"; params: { error: string } };

function isBridgeMessage(data: unknown): data is BridgeMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "wrightful-trace-bridge"
  );
}

/**
 * Load a Playwright trace's parsed model via the vendored trace-viewer
 * service worker. Mounts a hidden same-origin iframe on the SW bridge (which
 * registers the SW, fetches `contexts?trace=…`, and relays the result back
 * over postMessage) and keeps it mounted while the caller is — the bridge
 * client is what keeps the SW's trace cache alive for the snapshot iframes.
 *
 * `traceUrl` must be an ABSOLUTE URL (the SW resolves and range-reads the zip
 * itself); pass the signed artifact download URL resolved against the current
 * origin.
 */
export function useTraceModel(traceUrl: string): TraceModelState {
  const [state, setState] = useState<TraceModelState>({
    status: "loading",
    progress: null,
  });

  useEffect(() => {
    setState({ status: "loading", progress: null });

    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "Trace loader";
    iframe.src = `${BRIDGE_PATH}?trace=${encodeURIComponent(traceUrl)}`;

    let done = false;
    const timeout = window.setTimeout(() => {
      if (done) return;
      done = true;
      setState({
        status: "error",
        error:
          "Timed out loading the trace. The trace viewer's service worker may be blocked in this browser.",
      });
    }, BRIDGE_TIMEOUT_MS);

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframe.contentWindow) return;
      if (!isBridgeMessage(event.data)) return;
      const message = event.data;
      if (message.method === "progress") {
        if (!done) setState({ status: "loading", progress: message.params });
        return;
      }
      done = true;
      window.clearTimeout(timeout);
      if (message.method === "model") {
        setState({
          status: "ready",
          contextEntries: message.params.contextEntries,
        });
      } else {
        setState({ status: "error", error: message.params.error });
      }
    };

    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);

    return () => {
      done = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    };
  }, [traceUrl]);

  return state;
}
