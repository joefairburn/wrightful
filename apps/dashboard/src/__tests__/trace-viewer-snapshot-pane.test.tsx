import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapshotPane } from "@/trace-viewer/components/snapshot-pane";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeBridge,
  makeModel,
} from "./trace-viewer-fixture";

/**
 * Component tests for the center snapshot-scrubber pane: Before/Action/After
 * iframe derivation (`collectSnapshots`), the click-point carried on the
 * Action tab, the `snapshotInfo` URL bar, the canvas-from-screenshot toggle
 * (+ its localStorage persistence), the popout link, and the "no snapshot"
 * empty state — all against the shared synthetic fixture.
 */

const CANVAS_FROM_SCREENSHOT_KEY =
  "wrightful:trace-viewer:canvas-from-screenshot";

let originalResizeObserver: typeof ResizeObserver | undefined;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;
let restoreScrollIntoView: (() => void) | undefined;
let restorePointerCapture: (() => void) | undefined;

beforeEach(() => {
  window.localStorage.clear();

  originalResizeObserver = globalThis.ResizeObserver;
  class ResizeObserverStub {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element): void {
      this.#callback(
        [
          {
            target,
            contentRect: target.getBoundingClientRect(),
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;

  // SnapshotPane's stage sizes itself off the container's clientWidth/Height
  // (not getBoundingClientRect), but stub both — the fixed ~800×400 read
  // is what lets `scale > 0` and the iframes actually mount.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 400,
    left: 0,
    top: 0,
    right: 800,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);

  originalCreateObjectURL = URL.createObjectURL.bind(URL);
  originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();

  if (typeof Element.prototype.scrollIntoView === "function") {
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  } else {
    Element.prototype.scrollIntoView = vi.fn();
    restoreScrollIntoView = () => {
      // @ts-expect-error -- deleting a happy-dom-absent polyfill we added
      delete Element.prototype.scrollIntoView;
    };
  }

  if (typeof Element.prototype.setPointerCapture === "function") {
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(
      () => {},
    );
    vi.spyOn(Element.prototype, "releasePointerCapture").mockImplementation(
      () => {},
    );
  } else {
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    restorePointerCapture = () => {
      // @ts-expect-error -- deleting happy-dom-absent polyfills we added
      delete Element.prototype.setPointerCapture;
      // @ts-expect-error -- deleting happy-dom-absent polyfills we added
      delete Element.prototype.releasePointerCapture;
    };
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  restoreScrollIntoView?.();
  restoreScrollIntoView = undefined;
  restorePointerCapture?.();
  restorePointerCapture = undefined;
  window.localStorage.clear();
});

/** Parse a mounted snapshot iframe's `src` into a URL for param assertions. */
function iframeSrc(title: string): URL {
  const iframe = screen.getByTitle(title);
  return new URL(iframe.getAttribute("src") ?? "", "http://localhost");
}

describe("SnapshotPane", () => {
  it("renders Before/After iframes pointed at the action's before/after snapshots", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    render(
      <SnapshotPane
        action={action}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(iframeSrc("DOM snapshot (Before)").searchParams.get("name")).toBe(
      "before@call@1",
    );
    expect(iframeSrc("DOM snapshot (After)").searchParams.get("name")).toBe(
      "after@call@1",
    );
  });

  it("carries the recorded click point on the Action snapshot iframe", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@2")!;
    render(
      <SnapshotPane
        action={action}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    const url = iframeSrc("DOM snapshot (Action)");
    expect(url.searchParams.get("pointX")).toBe("5");
    expect(url.searchParams.get("pointY")).toBe("6");
  });

  it("shows the captured page URL once the snapshotInfo sidecar resolves", async () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    const bridge = makeBridge({
      "snapshotInfo/page@1": {
        url: "https://app.example/cart",
        viewport: { width: 800, height: 600 },
      },
    });
    render(
      <SnapshotPane
        action={action}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={bridge}
      />,
    );
    expect(await screen.findByText("https://app.example/cart")).toBeTruthy();
  });

  it("persists the canvas-from-screenshot toggle and threads it onto snapshot srcs", async () => {
    const user = userEvent.setup();
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    render(
      <SnapshotPane
        action={action}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    await user.click(
      screen.getByTitle(
        "Paint <canvas> content from the nearest screenshot (may be imprecise)",
      ),
    );
    expect(window.localStorage.getItem(CANVAS_FROM_SCREENSHOT_KEY)).toBe("1");
    expect(
      iframeSrc("DOM snapshot (After)").searchParams.get(
        "shouldPopulateCanvasFromScreenshot",
      ),
    ).toBe("1");
  });

  it("links the popout to the vendored snapshot.html shell", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    render(
      <SnapshotPane
        action={action}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    const link = screen.getByTitle("Open snapshot in a new tab");
    expect(link.getAttribute("href")).toContain(
      "/trace-viewer/snapshot.html?r=",
    );
  });

  it("shows the No snapshot empty state for an action that captured none", () => {
    // A standalone single-action model — collectSnapshots() would otherwise
    // walk sideways (previousActionByEndTime/nextActionByStartTime) and
    // borrow a neighboring action's before/after snapshot. Building this
    // through makeModel (rather than a bare makeAction()) still runs it
    // through the real MultiTraceModel indexing pass, so those prev/next
    // links exist (as no-ops, being the only action) instead of being
    // symbol-absent — the same shape a real single-action trace would have.
    const noSnapshotAction = makeAction({
      callId: "call@none",
      pageId: undefined,
      startTime: 4500,
      endTime: 4900,
    });
    const model = makeModel({ actions: [noSnapshotAction] });
    const action = model.actions.find((a) => a.callId === "call@none")!;
    render(
      <SnapshotPane
        action={action}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(screen.getByText("No snapshot")).toBeTruthy();
    expect(
      screen.getByText("This action did not capture a DOM snapshot."),
    ).toBeTruthy();
  });
});
