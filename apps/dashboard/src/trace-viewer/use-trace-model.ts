"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mountBridgeIframe } from "./bridge-iframe";
import type { ContextEntry } from "./vendor/entries";

/**
 * Silence watchdog: bail out if the loading iframe's bridge goes this long
 * without sending ANY message (SW blocked, bundle missing…). Reset on every
 * valid message it sends — `progress` included — so it bounds gaps between
 * messages rather than total load time; a large trace that keeps streaming
 * progress on a slow connection won't get killed mid-load.
 */
const BRIDGE_TIMEOUT_MS = 30_000;

/** Per-request ceiling for proxied fetches (sha1 blobs, snapshotInfo…). */
const BRIDGE_FETCH_TIMEOUT_MS = 20_000;

type Progress = { done: number; total: number };

export type TraceModelState =
  | { status: "loading"; progress: Progress | null }
  | { status: "error"; error: string }
  | {
      status: "ready";
      /**
       * The trace this model was parsed from. During an attempt switch it
       * keeps pointing at the PREVIOUS trace (the one the visible workbench
       * renders) until the next model lands — key the workbench on this, not
       * on the hook's `traceUrl` argument.
       */
      traceUrl: string;
      contextEntries: ContextEntry[];
      /**
       * Non-null while a different trace loads behind this model (the
       * stale-while-switching window). The previous workbench stays rendered;
       * show a lightweight indicator instead of tearing it down.
       */
      switching: { progress: Progress | null } | null;
    };

/**
 * Fetch proxy into the SW-controlled bridge client. The service worker only
 * answers `snapshotInfo/*` / `sha1/*` fetches from a controlled client, so
 * the dashboard funnels them through the bridge over postMessage. Paths are
 * relative to the SW scope (e.g. `sha1/<hash>?trace=…`). Methods reject on
 * HTTP failure, proxy error, or timeout.
 *
 * `traceUrl` is the absolute trace URL this bridge instance serves — the
 * SAME string as the `ready` model's `traceUrl` (see {@link TraceModelState}),
 * so callers no longer need to thread a separate `traceUrl` alongside the
 * bridge. Its identity changes only when a switched-to attempt's model lands
 * (mirroring `state.traceUrl`'s own lag during a switch) — never on the
 * unrelated re-renders in between.
 */
export type TraceBridge = {
  fetchJson: (path: string) => Promise<unknown>;
  fetchBlob: (path: string) => Promise<Blob>;
  readonly traceUrl: string;
};

type BridgeMessage =
  | { method: "progress"; params: Progress }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProgress(value: unknown): value is Progress {
  return (
    isRecord(value) &&
    typeof value.done === "number" &&
    Number.isFinite(value.done) &&
    typeof value.total === "number" &&
    Number.isFinite(value.total)
  );
}

/** Validate the complete postMessage protocol boundary owned by bridge.html.
 * Checking only the source tag would make `method`/`params` an unchecked cast
 * and turn a stale bridge asset into render-time exceptions. */
export function isBridgeMessage(data: unknown): data is BridgeMessage {
  if (!isRecord(data) || data.source !== "wrightful-trace-bridge") return false;
  const params = data.params;
  switch (data.method) {
    case "progress":
      return isProgress(params);
    case "model":
      return isRecord(params) && Array.isArray(params.contextEntries);
    case "error":
      return isRecord(params) && typeof params.error === "string";
    case "warm":
      return isRecord(params);
    case "fetchResult":
      return (
        isRecord(params) &&
        typeof params.id === "number" &&
        Number.isInteger(params.id) &&
        typeof params.ok === "boolean" &&
        typeof params.status === "number" &&
        Number.isFinite(params.status) &&
        (params.error === undefined || typeof params.error === "string")
      );
    default:
      return false;
  }
}

type PendingFetch = {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timeout: number;
};

/** Reject every in-flight fetch-proxy request, clearing its timeout first.
 * Shared by the persistent-effect teardown and `becomeActive`'s bridge
 * retirement — both are "this map's promises can never resolve now" cases. */
function rejectAllPending(
  pending: Map<number, PendingFetch>,
  reason: string,
): void {
  for (const [, entry] of pending) {
    window.clearTimeout(entry.timeout);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

/**
 * Load a Playwright trace's parsed model via the vendored trace-viewer
 * service worker. Mounts a hidden same-origin iframe on the SW bridge (which
 * registers the SW, fetches `contexts?trace=…`, and relays the result back
 * over postMessage) and keeps it mounted while the caller is — the bridge
 * client is what keeps the SW's trace cache alive for the snapshot iframes.
 * Also returns the {@link TraceBridge} fetch proxy backed by that same
 * bridge client.
 *
 * When `traceUrl` CHANGES while a model is ready (switching attempts), the
 * previous model — and the bridge iframe pinning its trace in the SW — stay
 * live while the new trace loads in a second hidden iframe; the state swaps
 * atomically when the new model arrives (the SW caches traces per URL, so
 * two bridge clients coexist fine — the hover prewarm already relies on
 * that). The `ready` state carries `switching` during that window so the
 * caller can keep the workbench rendered instead of dropping to a spinner.
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

  /** The bridge serving the CURRENT model (fetch-proxy target). During a
   * switch this stays the previous attempt's iframe until the swap. */
  const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
  /** Which trace the active iframe holds a READY model for; null before the
   * first model and after an error. Mirrors state so the load effect can
   * decide first-load vs switch without re-running on state changes. */
  const activeTraceUrlRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<number, PendingFetch>());
  const nextIdRef = useRef(1);

  // The trace URL the ACTIVE bridge iframe serves — mirrors `state.traceUrl`
  // (only present in the `ready` shape), so it only changes when a switch
  // completes, not on every intermediate progress/switching update.
  const readyTraceUrl = state.status === "ready" ? state.traceUrl : null;

  // requests are matched by id, and pending ones are rejected when the
  // bridge remounts. Recomputed (new identity) only when `readyTraceUrl`
  // changes — request/fetchJson/fetchBlob close over refs, so recreating
  // them is cheap and behaviorally identical; the new identity is what lets
  // consumers keyed on `bridge` react to an attempt swap.
  const bridge = useMemo<TraceBridge>(() => {
    const request = <T>(
      path: string,
      as: "json" | "blob",
      decode: (body: unknown) => T,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        const target = activeIframeRef.current?.contentWindow;
        if (!target) {
          reject(new Error("Trace bridge is not mounted."));
          return;
        }
        const id = nextIdRef.current++;
        const timeout = window.setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error("Timed out fetching from the trace."));
        }, BRIDGE_FETCH_TIMEOUT_MS);
        pendingRef.current.set(id, {
          resolve: (body) => {
            try {
              resolve(decode(body));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
          reject,
          timeout,
        });
        target.postMessage(
          { source: "wrightful-trace-host", method: "fetch", id, path, as },
          window.location.origin,
        );
      });
    return {
      fetchJson: (path) => request(path, "json", (body) => body),
      fetchBlob: (path) =>
        request(path, "blob", (body) => {
          if (!(body instanceof Blob)) {
            throw new Error("Trace bridge returned a non-Blob fetch body.");
          }
          return body;
        }),
      traceUrl: readyTraceUrl ?? "",
    };
  }, [readyTraceUrl]);

  // Persistent fetch-proxy plumbing. Lives OUTSIDE the per-trace effect so
  // replies from the previous attempt's bridge keep landing during a switch
  // (that effect's listener is already torn down by then).
  useEffect(() => {
    const pending = pendingRef.current;

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== activeIframeRef.current?.contentWindow) return;
      if (!isBridgeMessage(event.data)) return;
      if (event.data.method !== "fetchResult") return;
      const params = event.data.params;
      const entry = pending.get(params.id);
      if (!entry) return;
      pending.delete(params.id);
      window.clearTimeout(entry.timeout);
      if (params.ok) {
        entry.resolve(params.body);
      } else {
        entry.reject(
          new Error(params.error ?? `Trace fetch failed (${params.status}).`),
        );
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      activeIframeRef.current?.remove();
      activeIframeRef.current = null;
      activeTraceUrlRef.current = null;
      rejectAllPending(pending, "Trace bridge unmounted.");
    };
  }, []);

  useEffect(() => {
    // Switched back to the trace that's already active before the pending
    // load finished — nothing to load; just drop the switching indicator.
    if (activeTraceUrlRef.current === traceUrl && activeIframeRef.current) {
      setState((prev) =>
        prev.status === "ready" ? { ...prev, switching: null } : prev,
      );
      return;
    }

    // A ready model means this is an attempt SWITCH: keep it (and its bridge
    // iframe) rendered while the new trace loads. Otherwise (first load, or
    // reload after an error) show the full loading state.
    const isSwitch = activeTraceUrlRef.current !== null;
    setState((prev) =>
      isSwitch && prev.status === "ready"
        ? { ...prev, switching: { progress: null } }
        : { status: "loading", progress: null },
    );

    const iframe = mountBridgeIframe(traceUrl, "Trace loader");

    // Promote THIS iframe to fetch-proxy target, retiring the previous one.
    // In-flight fetches belong to the retired bridge and can never resolve —
    // reject them now instead of letting them ride out their timeouts.
    const becomeActive = (): void => {
      const previous = activeIframeRef.current;
      if (previous && previous !== iframe) {
        previous.remove();
        rejectAllPending(pendingRef.current, "Trace bridge unmounted.");
      }
      activeIframeRef.current = iframe;
    };

    // On a first load the bridge must be postable before the model arrives
    // (and any errored predecessor is retired); on a switch the previous
    // bridge keeps serving the visible workbench until the swap.
    if (!isSwitch) becomeActive();

    let done = false;
    const fail = (error: string): void => {
      done = true;
      becomeActive();
      activeTraceUrlRef.current = null;
      setState({ status: "error", error });
    };

    // Silence watchdog — see BRIDGE_TIMEOUT_MS. `armWatchdog` is (re)called on
    // every valid message from the loading iframe below, so the timer measures
    // the gap since the LAST message, not time since the load started.
    let watchdog = 0;
    const armWatchdog = (): void => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        if (done) return;
        fail(
          "Timed out loading the trace. The trace viewer's service worker may be blocked in this browser.",
        );
      }, BRIDGE_TIMEOUT_MS);
    };
    armWatchdog();

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframe.contentWindow) return;
      if (!isBridgeMessage(event.data)) return;
      const message = event.data;
      if (!done) armWatchdog();
      // `model` / `error` are the only TERMINAL transitions, and each lands
      // at most once (a stray second one is ignored rather than re-running
      // the transition). `isBridgeMessage` validates the full discriminated
      // protocol, so an unknown method or malformed payload from a stale
      // bridge asset is ignored before it can re-arm this watchdog.
      // `fetchResult` is handled by the persistent listener above (it targets
      // the ACTIVE iframe, not this loading one).
      switch (message.method) {
        case "fetchResult":
        case "warm":
          return;
        case "progress":
          if (done) return;
          setState((prev) =>
            isSwitch && prev.status === "ready"
              ? { ...prev, switching: { progress: message.params } }
              : { status: "loading", progress: message.params },
          );
          return;
        case "model":
          if (done) return;
          done = true;
          window.clearTimeout(watchdog);
          becomeActive();
          activeTraceUrlRef.current = traceUrl;
          setState({
            status: "ready",
            traceUrl,
            contextEntries: message.params.contextEntries,
            switching: null,
          });
          return;
        case "error":
          if (done) return;
          window.clearTimeout(watchdog);
          fail(message.params.error);
          return;
        default:
          return;
      }
    };

    window.addEventListener("message", onMessage);

    return () => {
      done = true;
      window.clearTimeout(watchdog);
      window.removeEventListener("message", onMessage);
      // Only tear down a load that never finished (superseded or unmounted
      // mid-flight). Once active, the iframe's removal belongs to the next
      // `becomeActive()` — or, on unmount, to the persistent effect above.
      if (activeIframeRef.current !== iframe) iframe.remove();
    };
  }, [traceUrl]);

  return { state, bridge };
}
