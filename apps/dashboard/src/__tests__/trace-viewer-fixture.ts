import type { TraceBridge } from "@/trace-viewer/use-trace-model";
import type { ContextEntry } from "@/trace-viewer/vendor/entries";
import { MultiTraceModel } from "@/trace-viewer/vendor/model-util";

/**
 * Shared synthetic-trace fixture for trace-viewer unit/component tests
 * (imported by the trace-viewer-*.test.ts* files; not itself a test file).
 * Mirrors the `contexts?trace=` JSON shape (vendor/entries.ts) with enough
 * variety to exercise every tab: hooks + api actions + a failing expect,
 * grouped (route/getter) actions, console + pageError events, HAR resources
 * with sha1 bodies, image/text/hidden attachments, stack frames, and
 * screencast frames.
 */

export const FIXTURE_TRACE_URL =
  "https://dash.test/api/artifacts/a1/download?t=tok";

type Action = ContextEntry["actions"][number];

export function makeAction(over: Record<string, unknown>): Action {
  return {
    type: "action",
    class: "Frame",
    method: "click",
    params: {},
    pageId: "page@1",
    log: [],
    ...over,
  } as unknown as Action;
}

export function makeContext(over?: Partial<ContextEntry>): ContextEntry {
  return {
    origin: "library",
    startTime: 1000,
    endTime: 5000,
    browserName: "chromium",
    channel: undefined,
    platform: "linux",
    playwrightVersion: "1.61.1",
    wallTime: 1_700_000_000_000,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    title: "fixture",
    options: { viewport: { width: 1280, height: 720 } },
    pages: [
      {
        pageId: "page@1",
        screencastFrames: [
          { sha1: "page@1-100.jpeg", timestamp: 1100, width: 640, height: 360 },
          { sha1: "page@1-200.jpeg", timestamp: 2500, width: 640, height: 360 },
          { sha1: "page@1-300.jpeg", timestamp: 4200, width: 640, height: 360 },
        ],
      },
    ],
    resources: [
      {
        pageref: "page@1",
        startedDateTime: "2026-07-10T00:00:01.000Z",
        time: 12.5,
        request: {
          method: "GET",
          url: "https://app.example/api/items?limit=10",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [{ name: "Accept", value: "application/json" }],
          queryString: [],
          headersSize: 100,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [{ name: "Content-Type", value: "application/json" }],
          content: {
            size: 42,
            mimeType: "application/json",
            _sha1: "bodysha1.json",
          },
          headersSize: 80,
          bodySize: 42,
          redirectURL: "",
          _transferSize: 130,
        },
        cache: {},
        timings: {
          dns: 1,
          connect: 2,
          ssl: -1,
          send: 0.5,
          wait: 6,
          receive: 3,
        },
        serverIPAddress: "127.0.0.1",
        _frameref: "frame@1",
        _monotonicTime: 2100,
        _resourceType: "fetch",
      },
      {
        pageref: "page@1",
        startedDateTime: "2026-07-10T00:00:02.000Z",
        time: 40,
        request: {
          method: "POST",
          url: "https://app.example/api/checkout",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: 90,
          bodySize: 17,
          postData: { mimeType: "application/json", text: '{"total": 12}' },
        },
        response: {
          status: 500,
          statusText: "Internal Server Error",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          content: { size: -1, mimeType: "text/plain" },
          headersSize: 60,
          bodySize: 9,
          redirectURL: "",
        },
        cache: {},
        timings: {
          dns: -1,
          connect: -1,
          ssl: -1,
          send: 1,
          wait: 30,
          receive: 9,
        },
        _frameref: "frame@1",
        _monotonicTime: 3600,
        _resourceType: "xhr",
      },
    ] as unknown as ContextEntry["resources"],
    actions: [
      makeAction({
        callId: "call@1",
        method: "goto",
        title: "Navigate to app",
        params: { url: "https://app.example/" },
        startTime: 1000,
        endTime: 1400,
        beforeSnapshot: "before@call@1",
        afterSnapshot: "after@call@1",
        stack: [{ file: "/repo/tests/checkout.spec.ts", line: 5, column: 3 }],
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        startTime: 2000,
        endTime: 2600,
        inputSnapshot: "input@call@2",
        point: { x: 5, y: 6 },
        afterSnapshot: "after@call@2",
        attachments: [
          {
            name: "shot.png",
            contentType: "image/png",
            sha1: "imgsha1.png",
          },
          {
            name: "notes.json",
            contentType: "application/json",
            sha1: "textsha1.json",
          },
          { name: "_hidden", contentType: "text/plain", sha1: "hidden" },
        ],
        stack: [
          { file: "/repo/tests/checkout.spec.ts", line: 9, column: 3 },
          { file: "/repo/tests/helpers.ts", line: 22, column: 5 },
        ],
      }),
      makeAction({
        callId: "call@3",
        class: "Route",
        method: "continue",
        title: "Route.continue",
        group: "route",
        startTime: 2050,
        endTime: 2060,
      }),
      makeAction({
        callId: "call@4",
        method: "expect",
        title: 'Expect "toHaveText"',
        params: { selector: "#total", expression: "to.have.text" },
        startTime: 3000,
        endTime: 4000,
        error: { name: "Error", message: "expect failed: total mismatch" },
        result: { received: "12", expected: "13" },
        stack: [{ file: "/repo/tests/checkout.spec.ts", line: 14, column: 3 }],
      }),
    ],
    events: [
      {
        type: "console",
        messageType: "log",
        text: "loading cart",
        args: [],
        location: {
          url: "https://app.example/app.js",
          lineNumber: 3,
          columnNumber: 1,
        },
        time: 1200,
        pageId: "page@1",
      },
      {
        type: "console",
        messageType: "error",
        text: "boom [31mred[0m",
        args: [],
        location: {
          url: "https://app.example/app.js",
          lineNumber: 9,
          columnNumber: 1,
        },
        time: 2200,
        pageId: "page@1",
      },
      {
        type: "event",
        method: "pageError",
        params: {
          error: { error: { name: "Error", message: "Uncaught kaboom" } },
        },
        time: 3500,
      },
    ] as unknown as ContextEntry["events"],
    stdio: [],
    errors: [],
    hasSource: true,
    contextId: "ctx@1",
    ...over,
  };
}

export function makeModel(over?: Partial<ContextEntry>): MultiTraceModel {
  return new MultiTraceModel(FIXTURE_TRACE_URL, [makeContext(over)]);
}

/**
 * TraceBridge fake: `responses` maps a path PREFIX (before `?`) to a JSON
 * value or Blob. Unmatched paths reject like a 404 would.
 */
export function makeBridge(
  responses: Record<string, unknown> = {},
): TraceBridge & { calls: string[] } {
  const calls: string[] = [];
  const lookup = (path: string): unknown => {
    const key = path.split("?")[0] ?? path;
    if (key in responses) return responses[key];
    throw new Error(`Trace fetch failed (404): ${key}`);
  };
  return {
    calls,
    fetchJson: (path: string) => {
      calls.push(path);
      return Promise.resolve().then(() => lookup(path));
    },
    fetchBlob: (path: string) => {
      calls.push(path);
      return Promise.resolve().then(() => {
        const value = lookup(path);
        return value instanceof Blob
          ? value
          : new Blob([
              typeof value === "string" ? value : JSON.stringify(value),
            ]);
      });
    },
  };
}
