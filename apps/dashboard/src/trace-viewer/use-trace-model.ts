"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextEntry } from "./vendor/entries";

/**
 * Where the SW bridge document lives (inside the /trace-viewer/ service-worker
 * scope — see `bridge.html` for why the dashboard page itself must never be
 * the SW-controlled client).
 */
const BRIDGE_PATH = "/trace-viewer/bridge.html";

/** Bail out if the bridge never reports back (SW blocked, bundle missing…). */
const BRIDGE_TIMEOUT_MS = 30_000;

/** Per-request ceiling for proxied fetches (sha1 blobs, snapshotInfo…). */
const BRIDGE_FETCH_TIMEOUT_MS = 20_000;

export type TraceModelState =
  | { status: "loading"; progress: { done: number; total: number } | null }
  | { status: "error"; error: string }
  | { status: "ready"; contextEntries: ContextEntry[] };

/**
 * Fetch proxy into the SW-controlled bridge client. The service worker only
 * answers `snapshotInfo/*` / `sha1/*` fetches from a controlled client, so
 * the dashboard funnels them through the bridge over postMessage. Paths are
 * relative to the SW scope (e.g. `sha1/<hash>?trace=…`). Methods reject on
 * HTTP failure, proxy error, or timeout. Stable identity for the lifetime of
 * the hook — safe to list in effect dependencies.
 */
export type TraceBridge = {
  fetchJson: (path: string) => Promise<unknown>;
  fetchBlob: (path: string) => Promise<Blob>;
};

type BridgeMessage =
  | { method: "progress"; params: { done: number; total: number } }
  | { method: "model"; params: { contextEntries: ContextEntry[] } }
  | { method: "error"; params: { error: string } }
  | { method: "warm"; params: Record<string, never> }
  | {
      method: "fetchResult";
      params: {
        id: number;
        ok: boolean;
        status: number;
        body?: unknown;
        error?: string;
      };
    };

function isBridgeMessage(data: unknown): data is BridgeMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "wrightful-trace-bridge"
  );
}

type PendingFetch = {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timeout: number;
};

/**
 * Load a Playwright trace's parsed model via the vendored trace-viewer
 * service worker. Mounts a hidden same-origin iframe on the SW bridge (which
 * registers the SW, fetches `contexts?trace=…`, and relays the result back
 * over postMessage) and keeps it mounted while the caller is — the bridge
 * client is what keeps the SW's trace cache alive for the snapshot iframes.
 * Also returns the {@link TraceBridge} fetch proxy backed by that same
 * bridge client.
 *
 * `traceUrl` must be an ABSOLUTE URL (the SW resolves and range-reads the zip
 * itself); pass the signed artifact download URL resolved against the current
 * origin.
 */
export function useTraceModel(traceUrl: string): {
  state: TraceModelState;
  bridge: TraceBridge;
} {
  const [state, setState] = useState<TraceModelState>({
    status: "loading",
    progress: null,
  });

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pendingRef = useRef(new Map<number, PendingFetch>());
  const nextIdRef = useRef(1);

  // Stable across renders and trace changes; requests are matched by id, and
  // pending ones are rejected when the bridge remounts.
  const bridge = useMemo<TraceBridge>(() => {
    const request = (path: string, as: "json" | "blob"): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const target = iframeRef.current?.contentWindow;
        if (!target) {
          reject(new Error("Trace bridge is not mounted."));
          return;
        }
        const id = nextIdRef.current++;
        const timeout = window.setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error("Timed out fetching from the trace."));
        }, BRIDGE_FETCH_TIMEOUT_MS);
        pendingRef.current.set(id, { resolve, reject, timeout });
        target.postMessage(
          { source: "wrightful-trace-host", method: "fetch", id, path, as },
          window.location.origin,
        );
      });
    return {
      fetchJson: (path) => request(path, "json"),
      fetchBlob: (path) => request(path, "blob") as Promise<Blob>,
    };
  }, []);

  useEffect(() => {
    setState({ status: "loading", progress: null });

    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "Trace loader";
    iframe.src = `${BRIDGE_PATH}?trace=${encodeURIComponent(traceUrl)}`;
    iframeRef.current = iframe;

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
      if (message.method === "fetchResult") {
        const pending = pendingRef.current.get(message.params.id);
        if (!pending) return;
        pendingRef.current.delete(message.params.id);
        window.clearTimeout(pending.timeout);
        if (message.params.ok) {
          pending.resolve(message.params.body);
        } else {
          pending.reject(
            new Error(
              message.params.error ??
                `Trace fetch failed (${message.params.status}).`,
            ),
          );
        }
        return;
      }
      if (message.method === "warm") return;
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

    const pending = pendingRef.current;
    return () => {
      done = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      if (iframeRef.current === iframe) iframeRef.current = null;
      for (const [, entry] of pending) {
        window.clearTimeout(entry.timeout);
        entry.reject(new Error("Trace bridge unmounted."));
      }
      pending.clear();
    };
  }, [traceUrl]);

  return { state, bridge };
}
