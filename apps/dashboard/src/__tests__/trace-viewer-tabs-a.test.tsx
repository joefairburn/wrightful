import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallTab } from "@/trace-viewer/components/call-tab";
import { ErrorsTab } from "@/trace-viewer/components/errors-tab";
import { MetadataTab } from "@/trace-viewer/components/metadata-tab";
import type { TraceTabProps } from "@/trace-viewer/model";
import {
  FIXTURE_TRACE_URL,
  makeBridge,
  makeModel,
} from "./trace-viewer-fixture";

// happy-dom gap: the vendored Base UI ScrollArea (used by ErrorsTab) polls
// viewport.getAnimations() on a timer; stub it so that doesn't throw.
Element.prototype.getAnimations = function getAnimationsNoop() {
  return [];
};

function baseProps(model: ReturnType<typeof makeModel>): TraceTabProps {
  return {
    model,
    selectedAction: undefined,
    onSelectAction: vi.fn(),
    traceUrl: FIXTURE_TRACE_URL,
    bridge: makeBridge(),
    scopeToSelected: false,
  };
}

afterEach(() => {
  cleanup();
});

describe("CallTab", () => {
  it("renders params for the selected action (#checkout)", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@2");
    render(<CallTab {...baseProps(model)} selectedAction={selectedAction} />);
    expect(screen.getByText('"#checkout"')).toBeTruthy();
  });

  it("renders the return value, duration and ANSI-colorized error for a failed action", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@4");
    render(<CallTab {...baseProps(model)} selectedAction={selectedAction} />);

    // Return value JSON preview.
    const returnValue = screen.getByText(/"received"/);
    expect(returnValue.textContent).toContain("received");
    expect(returnValue.textContent).toContain("12");

    // Duration (endTime 4000 - startTime 3000 = 1000ms -> formatDuration).
    expect(screen.getByText("1s")).toBeTruthy();

    // Error block is rendered via dangerouslySetInnerHTML from ansiToHtml —
    // assert the ANSI-colorized container carries the message text.
    expect(screen.getByText("Error")).toBeTruthy();
    const errorBlock = Array.from(document.querySelectorAll("pre")).find((el) =>
      el.textContent?.includes("expect failed: total mismatch"),
    );
    expect(errorBlock).toBeTruthy();
  });

  it("shows the empty-state message when no action is selected", () => {
    const model = makeModel();
    render(<CallTab {...baseProps(model)} selectedAction={undefined} />);
    expect(
      screen.getByText("Select an action to see its call details."),
    ).toBeTruthy();
  });
});

describe("ErrorsTab", () => {
  it("renders the error message", () => {
    const model = makeModel();
    render(<ErrorsTab {...baseProps(model)} />);
    expect(screen.getByText(/expect failed: total mismatch/)).toBeTruthy();
  });

  it("jumping to the failing action calls onSelectAction with its call id", async () => {
    const user = userEvent.setup();
    const model = makeModel();
    const onSelectAction = vi.fn();
    render(<ErrorsTab {...baseProps(model)} onSelectAction={onSelectAction} />);
    await user.click(screen.getByRole("button", { name: /toHaveText/i }));
    expect(onSelectAction).toHaveBeenCalledWith("call@4");
  });

  it("copies an LLM prompt to the clipboard and flips the label to Copied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const model = makeModel();
    render(<ErrorsTab {...baseProps(model)} />);

    const copyButton = screen.getByRole("button", { name: /copy prompt/i });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0]?.[0] as string;
    expect(written).toContain("expect failed: total mismatch");
    expect(written).toContain("Failing action:");

    expect(await screen.findByRole("button", { name: /copied/i })).toBeTruthy();
  });
});

describe("MetadataTab", () => {
  it("renders browser, viewport, playwright version and page count", () => {
    const model = makeModel();
    render(<MetadataTab {...baseProps(model)} />);
    expect(screen.getByText("chromium")).toBeTruthy();
    expect(screen.getByText("1280×720")).toBeTruthy();
    expect(screen.getByText("1.61.1")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // Pages count
  });
});
