import { describe, expect, it } from "vitest";
import {
  collectSnapshots,
  defaultSelectedActionId,
  describeTraceLoadError,
  sha1DownloadUrl,
  sha1Path,
  snapshotIframeUrl,
  snapshotInfoPath,
  snapshotViewport,
} from "@/trace-viewer/model";
import type { ContextEntry } from "@/trace-viewer/vendor/entries";
import { MultiTraceModel } from "@/trace-viewer/vendor/model-util";

/**
 * Minimal library-origin context mirroring the `contexts?trace=` JSON the
 * vendored SW serves (shape per vendor/entries.ts). Three actions:
 * a goto with before+after snapshots, a click with only an input snapshot,
 * and a failing expect with no snapshots.
 */
function fixtureContext(): ContextEntry {
  const action = (
    over: Record<string, unknown>,
  ): ContextEntry["actions"][number] =>
    ({
      type: "action",
      class: "Frame",
      method: "goto",
      params: {},
      pageId: "page@1",
      log: [],
      ...over,
    }) as unknown as ContextEntry["actions"][number];

  return {
    origin: "library",
    startTime: 1000,
    endTime: 2000,
    browserName: "chromium",
    wallTime: 1_700_000_000_000,
    options: { viewport: { width: 1280, height: 720 } },
    pages: [{ pageId: "page@1", screencastFrames: [] }],
    resources: [],
    actions: [
      action({
        callId: "call@1",
        method: "goto",
        startTime: 1000,
        endTime: 1100,
        beforeSnapshot: "before@call@1",
        afterSnapshot: "after@call@1",
      }),
      action({
        callId: "call@2",
        method: "click",
        startTime: 1200,
        endTime: 1300,
        inputSnapshot: "input@call@2",
        point: { x: 10, y: 20 },
      }),
      action({
        callId: "call@3",
        method: "expect",
        startTime: 1400,
        endTime: 1500,
        error: { name: "Error", message: "expect failed" },
      }),
    ],
    events: [],
    stdio: [],
    errors: [],
    hasSource: false,
    contextId: "ctx@1",
  };
}

const TRACE_URL = "https://dash.example/api/artifacts/a1/download?t=tok";

describe("trace-viewer model adapter", () => {
  const model = new MultiTraceModel(TRACE_URL, [fixtureContext()]);

  it("vendored TraceModel builds from a contexts payload", () => {
    expect(model.actions.map((a) => a.callId)).toEqual([
      "call@1",
      "call@2",
      "call@3",
    ]);
    expect(model.startTime).toBe(1000);
    expect(model.errorDescriptors).toHaveLength(1);
    expect(model.errorDescriptors[0]?.message).toBe("expect failed");
  });

  it("collectSnapshots uses the action's own snapshots when present", () => {
    const snapshots = collectSnapshots(model.actions[0]);
    expect(snapshots.before?.snapshotName).toBe("before@call@1");
    expect(snapshots.after?.snapshotName).toBe("after@call@1");
    // No inputSnapshot -> the Action tab falls back to After, carrying the
    // action's own (absent) point.
    expect(snapshots.action?.snapshotName).toBe("after@call@1");
    expect(snapshots.action?.point).toBeUndefined();
  });

  it("collectSnapshots borrows the previous afterSnapshot as Before", () => {
    const snapshots = collectSnapshots(model.actions[1]);
    expect(snapshots.before?.snapshotName).toBe("after@call@1");
    expect(snapshots.action?.snapshotName).toBe("input@call@2");
    expect(snapshots.action?.point).toEqual({ x: 10, y: 20 });
    // No own/descendant afterSnapshot -> falls back to the computed Before.
    expect(snapshots.after?.snapshotName).toBe("after@call@1");
  });

  it("collectSnapshots returns nothing for an empty selection", () => {
    expect(collectSnapshots(undefined)).toEqual({});
  });

  it("defaultSelectedActionId prefers the first failed action", () => {
    expect(defaultSelectedActionId(model)).toBe("call@3");
    const passing = new MultiTraceModel(TRACE_URL, [
      {
        ...fixtureContext(),
        actions: fixtureContext().actions.slice(0, 2),
      },
    ]);
    expect(defaultSelectedActionId(passing)).toBe("call@2");
  });

  it("snapshotIframeUrl targets the SW scope with trace/name/point params", () => {
    const snapshots = collectSnapshots(model.actions[1]);
    const url = new URL(
      snapshotIframeUrl(TRACE_URL, snapshots.action!),
      "https://dash.example",
    );
    expect(url.pathname).toBe("/trace-viewer/snapshot/page@1");
    expect(url.searchParams.get("trace")).toBe(TRACE_URL);
    expect(url.searchParams.get("name")).toBe("input@call@2");
    expect(url.searchParams.get("pointX")).toBe("10");
    expect(url.searchParams.get("pointY")).toBe("20");
  });

  it("sha1DownloadUrl carries download name and content type", () => {
    const url = new URL(
      sha1DownloadUrl(TRACE_URL, "abc123", "screenshot.png", "image/png"),
      "https://dash.example",
    );
    expect(url.pathname).toBe("/trace-viewer/sha1/abc123");
    expect(url.searchParams.get("dn")).toBe("screenshot.png");
    expect(url.searchParams.get("dct")).toBe("image/png");
    expect(url.searchParams.get("trace")).toBe(TRACE_URL);
  });

  it("bridge-proxy paths are scope-relative and carry the trace param", () => {
    // Bridge fetches resolve against /trace-viewer/bridge.html, so these
    // must be RELATIVE paths (no leading slash) with ?trace= for the SW.
    const info = snapshotInfoPath(
      TRACE_URL,
      collectSnapshots(model.actions[1]).action!,
    );
    expect(info.startsWith("snapshotInfo/page@1?")).toBe(true);
    expect(info).toContain(`trace=${encodeURIComponent(TRACE_URL)}`);
    expect(info).toContain("name=input%40call%402");

    const sha1 = sha1Path(TRACE_URL, "src@abc.txt");
    expect(sha1.startsWith("sha1/src@abc.txt?")).toBe(true);
    expect(sha1).toContain(`trace=${encodeURIComponent(TRACE_URL)}`);
  });

  it("snapshotViewport reads the recorded context viewport", () => {
    expect(snapshotViewport(model.actions[0]!)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("describeTraceLoadError makes the version mismatch actionable", () => {
    expect(
      describeTraceLoadError(
        "The trace was created by a newer version of Playwright and is not supported…",
      ),
    ).toMatch(/newer Playwright version/);
    expect(describeTraceLoadError("boom")).toBe("boom");
  });
});
