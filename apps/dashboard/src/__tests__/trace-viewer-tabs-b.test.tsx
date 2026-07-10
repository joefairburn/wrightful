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
import { AttachmentsTab } from "@/trace-viewer/components/attachments-tab";
import { ConsoleTab } from "@/trace-viewer/components/console-tab";
import { NetworkTab } from "@/trace-viewer/components/network-tab";
import type { TraceTabProps } from "@/trace-viewer/model";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeBridge,
  makeContext,
  makeModel,
} from "./trace-viewer-fixture";

/**
 * Component tests for the three "leaf" detail tabs that render off a plain
 * `TraceTabProps` (no bridge-mounted trace, no service worker) — Console,
 * Network, Attachments. Exercises ANSI stripping, action-window scoping,
 * the network request detail panel (headers/timing/bodies), and attachment
 * previews/downloads, all against the shared synthetic fixture
 * (`trace-viewer-fixture.ts`).
 */

// ResizeObserver: happy-dom ships a polyfill, but it never actually fires
// (no real layout engine driving it), which would leave every measured
// pane at 0×0. Stub it to invoke synchronously off the (also stubbed)
// bounding rect, mirroring the sibling snapshot-pane/timeline suites.
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;
let restoreScrollIntoView: (() => void) | undefined;
let restorePointerCapture: (() => void) | undefined;
let restoreGetAnimations: (() => void) | undefined;

beforeEach(() => {
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

  const hasPointerCapture =
    typeof Element.prototype.setPointerCapture === "function";
  if (hasPointerCapture) {
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

  // Base UI's ScrollArea (used by every tab here) probes the Web Animations
  // API on its viewport; happy-dom doesn't implement it, which would
  // otherwise fire an unhandled rejection from a detached setTimeout well
  // after the test that triggered it has finished.
  if (typeof Element.prototype.getAnimations !== "function") {
    Element.prototype.getAnimations = vi.fn(() => []);
    restoreGetAnimations = () => {
      // @ts-expect-error -- deleting a happy-dom-absent polyfill we added
      delete Element.prototype.getAnimations;
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
  restoreGetAnimations?.();
  restoreGetAnimations = undefined;
});

function baseProps(overrides: Partial<TraceTabProps> = {}): TraceTabProps {
  return {
    model: makeModel(),
    selectedAction: undefined,
    onSelectAction: vi.fn(),
    traceUrl: FIXTURE_TRACE_URL,
    bridge: makeBridge(),
    scopeToSelected: false,
    ...overrides,
  };
}

describe("ConsoleTab", () => {
  it("renders every console/pageError row, stripping ANSI residue", () => {
    render(<ConsoleTab {...baseProps()} />);
    expect(screen.getByText("loading cart")).toBeTruthy();
    expect(screen.getByText("boom red")).toBeTruthy();
    expect(screen.getByText("Uncaught kaboom")).toBeTruthy();
    expect(screen.queryByText(/\[31m/)).toBeNull();
  });

  it("scopes to the selected action's window, keeping only in-window events", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@2")!;
    render(
      <ConsoleTab
        {...baseProps({ model, selectedAction, scopeToSelected: true })}
      />,
    );
    expect(screen.getByText("boom red")).toBeTruthy();
    expect(screen.queryByText("loading cart")).toBeNull();
    expect(screen.queryByText("Uncaught kaboom")).toBeNull();
  });

  it("shows a scoped-empty message when the action's window has no console output", () => {
    const defaultActions = makeContext().actions;
    const quietAction = makeAction({
      callId: "call@5",
      method: "click",
      title: "Click nothing",
      startTime: 4500,
      endTime: 4900,
    });
    const model = makeModel({ actions: [...defaultActions, quietAction] });
    const selectedAction = model.actions.find((a) => a.callId === "call@5")!;
    render(
      <ConsoleTab
        {...baseProps({ model, selectedAction, scopeToSelected: true })}
      />,
    );
    expect(
      screen.getByText("No console output during this action."),
    ).toBeTruthy();
  });
});

describe("NetworkTab", () => {
  it("renders both HAR entries, flagging the 500 response as failing", () => {
    render(<NetworkTab {...baseProps()} />);
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("checkout")).toBeTruthy();
    expect(screen.getByText("500").className).toContain("text-fail");
  });

  it("opens a request detail panel on row click and closes it via the X button", async () => {
    const user = userEvent.setup();
    const { container } = render(<NetworkTab {...baseProps()} />);
    await user.click(screen.getByText("items"));
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Request headers")).toBeTruthy();
    // Timing legend: SSL is -1 (unset) and skipped; the rest render as
    // "<Label> <value>ms" text spread across sibling text nodes, so assert
    // against the panel's flattened text rather than a single element match.
    expect(container.textContent).toContain("DNS 1.0ms");
    expect(container.textContent).toContain("Wait 6.0ms");

    await user.click(
      screen.getByRole("button", { name: /close request details/i }),
    );
    expect(screen.queryByText("General")).toBeNull();
  });

  it("pretty-prints a JSON request body", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...baseProps()} />);
    await user.click(screen.getByText("checkout"));
    expect(screen.getByText("Request body")).toBeTruthy();
    expect(screen.getByText(/"total":\s*12/)).toBeTruthy();
  });

  it("resolves and pretty-prints a JSON response body via the bridge", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({ "sha1/bodysha1.json": '{"a":1}' });
    render(<NetworkTab {...baseProps({ bridge })} />);
    await user.click(screen.getByText("items"));
    expect(await screen.findByText(/"a":\s*1/)).toBeTruthy();
  });

  it("scopes rows to the selected action's window", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@2")!;
    render(
      <NetworkTab
        {...baseProps({ model, selectedAction, scopeToSelected: true })}
      />,
    );
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.queryByText("checkout")).toBeNull();
  });
});

describe("AttachmentsTab", () => {
  it("shows only visible attachments (leading-underscore ones are filtered out)", () => {
    render(<AttachmentsTab {...baseProps()} />);
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByText("notes.json")).toBeTruthy();
    expect(screen.queryByText("_hidden")).toBeNull();
  });

  it("renders an image attachment preview once the bridge resolves the blob", async () => {
    const bridge = makeBridge({ "sha1/imgsha1.png": new Blob(["x"]) });
    render(<AttachmentsTab {...baseProps({ bridge })} />);
    expect(await screen.findByAltText("shot.png")).toBeTruthy();
  });

  it("expands a JSON attachment's chevron to show its pretty-printed contents", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({ "sha1/textsha1.json": '{"k":1}' });
    render(<AttachmentsTab {...baseProps({ bridge })} />);
    await user.click(screen.getByTitle("Preview attachment contents"));
    expect(await screen.findByText(/"k":\s*1/)).toBeTruthy();
  });

  it("downloads sha1-backed attachments through the trace-viewer SW route in a new tab", () => {
    render(<AttachmentsTab {...baseProps()} />);
    const links = screen.getAllByRole("link", { name: /download/i });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toContain("/trace-viewer/sha1/");
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });
});
