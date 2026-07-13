import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailTabs } from "@/trace-viewer/components/detail-tabs";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeBridge,
  makeModel,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

// happy-dom gaps hit by the vendored Base UI ScrollArea / action-row ref:
// getAnimations() isn't implemented (ScrollAreaViewport polls it on a
// timer), and scrollIntoView isn't implemented either. Both are no-ops here.
let restoreDomStubs: () => void;
beforeAll(() => {
  restoreDomStubs = installTraceViewerDomStubs({
    getAnimations: true,
    scrollIntoView: true,
  });
});
afterAll(() => {
  restoreDomStubs();
});

function tab(name: string): HTMLElement {
  const found = screen
    .getAllByRole("tab")
    .find((t) => t.textContent?.startsWith(name));
  if (!found) throw new Error(`no tab labelled "${name}"`);
  return found;
}

afterEach(() => {
  cleanup();
});

describe("DetailTabs — default tab", () => {
  it("defaults to Errors when the model has errors", () => {
    const model = makeModel();
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(tab("Errors").getAttribute("aria-selected")).toBe("true");
  });

  it("defaults to Call when the model has no errors", () => {
    // Same shape as the fixture but without call@4, the only action that
    // carries an error.
    const model = makeModel({
      actions: [
        makeAction({
          callId: "call@1",
          method: "goto",
          title: "Navigate to app",
          params: { url: "https://app.example/" },
          startTime: 1000,
          endTime: 1400,
        }),
      ],
    });
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(tab("Call").getAttribute("aria-selected")).toBe("true");
    expect(tab("Errors").getAttribute("aria-selected")).toBe("false");
  });
});

describe("DetailTabs — tab label counts", () => {
  it("shows whole-trace counts on Errors, Console, Network and Attachments", () => {
    const model = makeModel();
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(tab("Errors").textContent).toBe("Errors1");
    expect(tab("Console").textContent).toBe("Console3");
    expect(tab("Network").textContent).toBe("Network2");
    // The `_hidden` attachment on call@2 is excluded from visibleAttachments —
    // 3 raw attachments, 2 visible.
    expect(tab("Attachments").textContent).toBe("Attachments2");
  });
});

describe("DetailTabs — Source tab presence", () => {
  it("is present when the model has source", () => {
    const model = makeModel({ hasSource: true });
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(
      screen.getAllByRole("tab").some((t) => t.textContent === "Source"),
    ).toBe(true);
  });

  it("is absent when the model has no source", () => {
    const model = makeModel({ hasSource: false });
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(
      screen.getAllByRole("tab").some((t) => t.textContent === "Source"),
    ).toBe(false);
  });
});

describe("DetailTabs — crosshair scope toggle", () => {
  const scopeToggle = () =>
    screen.queryByRole("button", { pressed: false }) ??
    screen.queryByRole("button", { pressed: true });

  it("is absent on Call and Errors", () => {
    const model = makeModel();
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );
    expect(scopeToggle()).toBeNull();
  });

  it("is present on Console and Network, and clicking sets aria-pressed", async () => {
    const user = userEvent.setup();
    const model = makeModel();
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );

    await user.click(tab("Console"));
    const consoleToggle = scopeToggle();
    expect(consoleToggle?.getAttribute("aria-pressed")).toBe("false");
    await user.click(consoleToggle!);
    expect(consoleToggle?.getAttribute("aria-pressed")).toBe("true");

    await user.click(tab("Network"));
    expect(scopeToggle()).not.toBeNull();
  });
});

describe("DetailTabs — panel switching", () => {
  it("renders a distinctive panel for each tab", async () => {
    const user = userEvent.setup();
    const model = makeModel();
    render(
      <DetailTabs
        model={model}
        selectedAction={model.actions[0]}
        onSelectAction={vi.fn()}
        traceUrl={FIXTURE_TRACE_URL}
        bridge={makeBridge()}
      />,
    );

    await user.click(tab("Call"));
    expect(screen.getByText("Navigate to app")).toBeTruthy();

    await user.click(tab("Log"));
    expect(screen.getByText("No log entries for this action.")).toBeTruthy();

    await user.click(tab("Errors"));
    expect(screen.getByText(/expect failed: total mismatch/)).toBeTruthy();

    await user.click(tab("Console"));
    expect(screen.getByText("loading cart")).toBeTruthy();

    await user.click(tab("Network"));
    expect(screen.getAllByText(/checkout/).length).toBeGreaterThan(0);

    await user.click(tab("Source"));
    expect(screen.getByText("checkout.spec.ts")).toBeTruthy();

    await user.click(tab("Attachments"));
    expect(screen.getByText("shot.png")).toBeTruthy();

    await user.click(tab("Metadata"));
    expect(screen.getByText("chromium")).toBeTruthy();
    expect(screen.getByText("1.61.1")).toBeTruthy();
  });
});
