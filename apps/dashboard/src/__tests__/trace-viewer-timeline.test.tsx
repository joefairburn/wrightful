import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Timeline } from "@/trace-viewer/components/timeline";
import { makeBridge, makeModel } from "./trace-viewer-fixture";

/**
 * Component tests for the filmstrip + click-to-seek timeline strip: one
 * action bar per positive-duration action (fail/ring styling), bridge-backed
 * filmstrip thumbnails, click-to-seek resolving to the action active at the
 * clicked time, and the zero-duration no-op render — against the shared
 * synthetic fixture (`trace-viewer-fixture.ts`).
 */

let originalResizeObserver: typeof ResizeObserver | undefined;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;
let restorePointerCapture: (() => void) | undefined;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  class ResizeObserverStub {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element): void {
      // Timeline reads `entries[0].contentRect.width`, unlike snapshot-pane's
      // stage (which reads clientWidth/Height directly) — feed both shapes.
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

  // left:0/width:800 is load-bearing for the click-to-seek test's fraction
  // math (clientX=400 -> fraction 0.5), not just a sizing nicety.
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
  restorePointerCapture?.();
  restorePointerCapture = undefined;
});

describe("Timeline", () => {
  it("renders one action bar per positive-duration action, flags the failing one, and rings the selected one", () => {
    const model = makeModel();
    // call@4 is the only action with an error — pick a DIFFERENT action as
    // selected so the fail-red and selected-ring styling land on separate
    // bars (selection styling takes precedence over the fail color).
    const { container } = render(
      <Timeline
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@1"
        onSelect={vi.fn()}
      />,
    );
    const bars = [...container.querySelectorAll(".rounded-sm")];
    // call@1 (400ms), call@2 (600ms), call@3 (10ms), call@4 (1000ms) — all
    // positive-duration, so all four actions get a bar.
    expect(bars).toHaveLength(4);
    expect(bars.some((bar) => bar.className.includes("bg-fail"))).toBe(true);
    expect(bars.some((bar) => bar.className.includes("bg-ring"))).toBe(true);
  });

  it("renders filmstrip thumbnails fetched through the bridge", async () => {
    const model = makeModel();
    const bridge = makeBridge({
      "sha1/page@1-100.jpeg": new Blob(["a"]),
      "sha1/page@1-200.jpeg": new Blob(["b"]),
      "sha1/page@1-300.jpeg": new Blob(["c"]),
    });
    const { container } = render(
      <Timeline
        model={model}
        bridge={bridge}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    // Thumbnails are decorative (`alt=""`), which maps to the "presentation"
    // ARIA role — getByRole("img") would never match them — so assert via a
    // plain DOM query instead, polled until the bridge blob fetches resolve.
    await waitFor(() => {
      expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
    });
  });

  it("seeks to the action active at the clicked time on pointerdown", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Timeline
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={onSelect}
      />,
    );
    const strip = container.querySelector(".cursor-crosshair");
    expect(strip).toBeTruthy();
    // rect is {left:0, width:800}; clientX=400 -> fraction 0.5 -> t = 1000 +
    // 0.5*4000 = 3000, whose active action (latest startTime <= 3000) is
    // call@4 (startTime 3000).
    fireEvent.pointerDown(strip!, { clientX: 400, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith("call@4");
  });

  it("renders nothing for a zero-duration trace", () => {
    const model = makeModel({
      startTime: 1000,
      endTime: 1000,
      actions: [],
      pages: [],
      resources: [],
      events: [],
    });
    const { container } = render(
      <Timeline
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
