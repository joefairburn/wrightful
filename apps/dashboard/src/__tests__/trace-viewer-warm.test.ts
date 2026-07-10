import { describe, expect, it } from "vite-plus/test";
import { warmTraceViewer } from "@/trace-viewer/warm";

/**
 * `warmTraceViewer` mounts a hidden bridge iframe per distinct URL and is
 * idempotent per URL via a MODULE-LEVEL `warmed` Set (see warm.ts) — there is
 * no reset hook. Each test below uses its own unique trace URL so tests don't
 * dedupe against each other; the one exception is the bare (no-arg) call,
 * which always targets the same src and is covered in a single self-contained
 * test (first-call-mounts + repeat-calls-are-no-ops) rather than split across
 * tests that would otherwise depend on run order.
 */

describe("warmTraceViewer", () => {
  // The bare (no-arg) call always targets the SAME src, so — unlike the
  // per-trace-URL cases below — the "first call mounts" and "repeat calls are
  // a no-op" assertions can't be split across tests without one depending on
  // the other via the module-level `warmed` Set. Kept as one test instead.
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

  it("dedupes repeat calls with the SAME trace URL to a single iframe", () => {
    const traceUrl = "https://dash.test/api/artifacts/warm-2/download?t=tok";
    const expectedSrc = `/trace-viewer/bridge.html?trace=${encodeURIComponent(traceUrl)}`;

    warmTraceViewer(traceUrl);
    warmTraceViewer(traceUrl);
    warmTraceViewer(traceUrl);

    expect(
      document.querySelectorAll(`iframe[src="${expectedSrc}"]`),
    ).toHaveLength(1);
  });

  it("mounts a SEPARATE iframe per distinct trace URL", () => {
    const urlA = "https://dash.test/api/artifacts/warm-3a/download?t=tok";
    const urlB = "https://dash.test/api/artifacts/warm-3b/download?t=tok";
    const srcA = `/trace-viewer/bridge.html?trace=${encodeURIComponent(urlA)}`;
    const srcB = `/trace-viewer/bridge.html?trace=${encodeURIComponent(urlB)}`;

    warmTraceViewer(urlA);
    warmTraceViewer(urlB);

    expect(document.querySelectorAll(`iframe[src="${srcA}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`iframe[src="${srcB}"]`)).toHaveLength(1);
  });
});
