import { describe, expect, it } from "vite-plus/test";
import { warmTraceViewer } from "@/trace-viewer/warm";

/**
 * `warmTraceViewer` keeps at most ONE full-prefetch iframe alive (each pins a
 * fully parsed trace in the SW), replacing it when a different artifact is
 * warmed, and dedupes on the artifact path — not the exact signed URL, whose
 * token rotates per page load. State is module-level with no reset hook, so
 * each test below uses its own unique artifact path; the bare (no-arg)
 * register-only call always targets the same src and is covered in a single
 * self-contained test rather than split across order-dependent tests.
 */

function prefetchIframes(): HTMLIFrameElement[] {
  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src^="/trace-viewer/bridge.html?trace="]',
    ),
  );
}

describe("warmTraceViewer", () => {
  it("mounts exactly one iframe for the bare warm-mode call, and repeats are no-ops", () => {
    const before = document.querySelectorAll(
      'iframe[src="/trace-viewer/bridge.html"]',
    ).length;

    warmTraceViewer();
    warmTraceViewer();
    warmTraceViewer();

    const after = document.querySelectorAll(
      'iframe[src="/trace-viewer/bridge.html"]',
    );
    expect(after).toHaveLength(before + 1);
    const iframe = after[after.length - 1] as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
    expect(iframe.getAttribute("aria-hidden")).toBe("true");
  });

  it("mounts one iframe carrying the encoded trace param for a full prefetch", () => {
    const traceUrl = "https://dash.test/api/artifacts/warm-1/download?t=tok";
    const expectedSrc = `/trace-viewer/bridge.html?trace=${encodeURIComponent(traceUrl)}`;

    warmTraceViewer(traceUrl);

    const iframes = document.querySelectorAll(`iframe[src="${expectedSrc}"]`);
    expect(iframes).toHaveLength(1);
  });

  it("dedupes repeat warms of the same artifact even when the signed token rotates", () => {
    const tokenA = "https://dash.test/api/artifacts/warm-2/download?t=tok-a";
    const tokenB = "https://dash.test/api/artifacts/warm-2/download?t=tok-b";

    warmTraceViewer(tokenA);
    warmTraceViewer(tokenA);
    warmTraceViewer(tokenB);

    const matching = prefetchIframes().filter((iframe) =>
      iframe.src.includes(encodeURIComponent("/artifacts/warm-2/")),
    );
    expect(matching).toHaveLength(1);
    // The first mint won; the rotated token did not remount.
    expect(matching[0]?.src).toContain(encodeURIComponent(tokenA));
  });

  it("replaces the previous prefetch iframe when a DIFFERENT trace is warmed", () => {
    const urlA = "https://dash.test/api/artifacts/warm-3a/download?t=tok";
    const urlB = "https://dash.test/api/artifacts/warm-3b/download?t=tok";

    warmTraceViewer(urlA);
    const mounted = prefetchIframes().find((iframe) =>
      iframe.src.includes(encodeURIComponent(urlA)),
    );
    expect(mounted).toBeDefined();

    warmTraceViewer(urlB);
    // The old iframe is gone (its pinned trace released); only B remains.
    expect(mounted?.isConnected).toBe(false);
    const remaining = prefetchIframes();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.src).toContain(encodeURIComponent(urlB));
  });
});
