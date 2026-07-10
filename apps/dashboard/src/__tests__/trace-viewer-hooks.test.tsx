import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useObjectUrl } from "@/trace-viewer/use-object-url";
import { useTraceModel } from "@/trace-viewer/use-trace-model";
import { makeBridge } from "./trace-viewer-fixture";

/**
 * `useObjectUrl` (bridge blob → object URL) and `useTraceModel` (the hidden
 * bridge iframe + postMessage protocol) — the two trace-viewer hooks with no
 * existing coverage. `trace-viewer-model.test.ts` covers the pure adapter
 * functions; this file covers the stateful React hooks.
 *
 * Happy-dom turned out to fully support the postMessage contract this hook
 * relies on — `iframe.contentWindow` is populated once the iframe is attached,
 * and a `MessageEvent` dispatched with an explicit `source` satisfies the
 * hook's `event.source === iframe.contentWindow` check — so the message-driven
 * transitions (ready/error/progress/fetch round-trip) are exercised directly
 * rather than only the timeout/unmount fallbacks.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The hidden iframe's `src` triggers a real happy-dom navigation/fetch
// attempt (to a non-existent localhost:3000), which logs a noisy but
// harmless ECONNREFUSED to stderr for every mounted hook in this file — the
// hook itself never awaits that fetch, so it doesn't affect any assertion.

function postMessageFrom(
  iframe: HTMLIFrameElement,
  data: Record<string, unknown>,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: window.location.origin,
      source: iframe.contentWindow as unknown as Window,
    }),
  );
}

/** Wait one macrotask so the iframe's `contentWindow` is populated. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useObjectUrl", () => {
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  let urlSeq = 0;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  function stubObjectUrls(): void {
    urlSeq = 0;
    createObjectURL = vi.fn(() => `blob:test-${++urlSeq}`);
    revokeObjectURL = vi.fn();
    URL.createObjectURL =
      createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL =
      revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  }

  afterEach(() => {
    cleanup();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("resolves a matched sha1 path to an object URL", async () => {
    stubObjectUrls();
    const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
    const { result, unmount } = renderHook(() =>
      useObjectUrl(bridge, "sha1/x?trace=t"),
    );

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current).toEqual({ url: "blob:test-1", error: false });
    expect(bridge.calls).toEqual(["sha1/x?trace=t"]);
    unmount();
  });

  it("reports an error for an unmatched path", async () => {
    stubObjectUrls();
    const bridge = makeBridge({});
    const { result, unmount } = renderHook(() =>
      useObjectUrl(bridge, "sha1/missing?trace=t"),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current).toEqual({ url: null, error: true });
    expect(createObjectURL).not.toHaveBeenCalled();
    unmount();
  });

  it("stays null and makes zero bridge calls when path is null", () => {
    stubObjectUrls();
    const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
    const { result, unmount } = renderHook(() => useObjectUrl(bridge, null));

    expect(result.current).toEqual({ url: null, error: false });
    expect(bridge.calls).toHaveLength(0);
    unmount();
  });

  it("revokes the object URL on unmount", async () => {
    stubObjectUrls();
    const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
    const { result, unmount } = renderHook(() =>
      useObjectUrl(bridge, "sha1/x?trace=t"),
    );

    await waitFor(() => expect(result.current.url).not.toBeNull());
    const url = result.current.url;
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("revokes the previous URL when the path changes", async () => {
    stubObjectUrls();
    const bridge = makeBridge({
      "sha1/x": new Blob(["hi"]),
      "sha1/y": new Blob(["yo"]),
    });
    const { result, rerender, unmount } = renderHook(
      ({ path }: { path: string | null }) => useObjectUrl(bridge, path),
      { initialProps: { path: "sha1/x?trace=t" as string | null } },
    );

    await waitFor(() => expect(result.current.url).not.toBeNull());
    const firstUrl = result.current.url;

    rerender({ path: "sha1/y?trace=t" });
    await waitFor(() => expect(result.current.url).not.toBe(firstUrl));

    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
    unmount();
  });
});

describe("useTraceModel — mount + protocol", () => {
  const TRACE_URL = "https://dash.test/api/artifacts/a1/download?t=tok";

  afterEach(() => {
    cleanup();
  });

  it("starts in loading state with no progress", () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("mounts a single hidden iframe whose src carries the encoded trace URL", () => {
    const { unmount } = renderHook(() => useTraceModel(TRACE_URL));

    const iframes = document.querySelectorAll("iframe");
    expect(iframes).toHaveLength(1);
    const iframe = iframes[0] as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
    expect(iframe.getAttribute("src")).toBe(
      `/trace-viewer/bridge.html?trace=${encodeURIComponent(TRACE_URL)}`,
    );
    expect(document.body.contains(iframe)).toBe(true);
    unmount();
  });

  it("transitions to ready on a model message", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "model",
        params: { contextEntries: [] },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "ready",
        contextEntries: [],
      }),
    );
    unmount();
  });

  it("transitions to error on an error message", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "error",
        params: { error: "bad zip" },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "error",
        error: "bad zip",
      }),
    );
    unmount();
  });

  it("reflects a progress message while still loading", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "progress",
        params: { done: 3, total: 10 },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "loading",
        progress: { done: 3, total: 10 },
      }),
    );
    unmount();
  });

  it("ignores messages from the wrong origin", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "wrightful-trace-bridge",
            method: "model",
            params: { contextEntries: [] },
          },
          origin: "https://evil.example",
          source: iframe.contentWindow as unknown as Window,
        }),
      );
    });

    // Give any (incorrect) state transition a tick to happen, then assert
    // the hook is still loading — the origin check must have dropped it.
    await flush();
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("ignores messages not tagged with the bridge source", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "some-other-sender",
        method: "model",
        params: { contextEntries: [] },
      });
    });

    await flush();
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("resolves bridge.fetchJson via a fetchResult round-trip", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    let capturedId: number | null = null;
    const contentWindow = iframe.contentWindow!;
    const originalPostMessage = contentWindow.postMessage.bind(contentWindow);
    contentWindow.postMessage = ((data: unknown, ...rest: unknown[]) => {
      capturedId = (data as { id?: number }).id ?? null;
      return (originalPostMessage as (...a: unknown[]) => unknown)(
        data,
        ...rest,
      );
    }) as typeof contentWindow.postMessage;

    const fetchPromise = result.current.bridge.fetchJson("sha1/x?trace=t");
    await flush();
    expect(capturedId).not.toBeNull();

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: { id: capturedId, ok: true, status: 200, body: { hi: 1 } },
      });
    });

    await expect(fetchPromise).resolves.toEqual({ hi: 1 });
    unmount();
  });

  it("rejects bridge.fetchJson when the fetchResult reports a failure", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    let capturedId: number | null = null;
    const contentWindow = iframe.contentWindow!;
    const originalPostMessage = contentWindow.postMessage.bind(contentWindow);
    contentWindow.postMessage = ((data: unknown, ...rest: unknown[]) => {
      capturedId = (data as { id?: number }).id ?? null;
      return (originalPostMessage as (...a: unknown[]) => unknown)(
        data,
        ...rest,
      );
    }) as typeof contentWindow.postMessage;

    const fetchPromise = result.current.bridge.fetchJson(
      "sha1/missing?trace=t",
    );
    await flush();

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: { id: capturedId, ok: false, status: 404 },
      });
    });

    await expect(fetchPromise).rejects.toThrow("Trace fetch failed (404).");
    unmount();
  });

  it("times out into an error state after 30s with no bridge response", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.state).toEqual({
      status: "error",
      error:
        "Timed out loading the trace. The trace viewer's service worker may be blocked in this browser.",
    });
    unmount();
    vi.useRealTimers();
  });

  it("removes the iframe on unmount", () => {
    const { unmount } = renderHook(() => useTraceModel(TRACE_URL));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    unmount();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("rejects a pending bridge fetch with 'unmounted' once the hook unmounts", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();

    const fetchPromise = result.current.bridge.fetchJson("sha1/x?trace=t");
    unmount();

    await expect(fetchPromise).rejects.toThrow("Trace bridge unmounted.");
  });

  it("rejects bridge.fetchJson immediately when the iframe was never mounted (post-unmount call)", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    unmount();

    await expect(
      result.current.bridge.fetchJson("sha1/x?trace=t"),
    ).rejects.toThrow("Trace bridge is not mounted.");
  });
});
