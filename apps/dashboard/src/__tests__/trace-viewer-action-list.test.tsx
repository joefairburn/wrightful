import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionList } from "@/trace-viewer/components/action-list";
import { makeAction, makeModel } from "./trace-viewer-fixture";

// happy-dom doesn't implement scrollIntoView; the selected-row ref callback
// calls it unconditionally, so a no-op polyfill keeps render from throwing.
Element.prototype.scrollIntoView = function scrollIntoViewNoop() {
  /* not implemented in happy-dom */
};

const SHOWN_GROUPS_KEY = "wrightful:trace-viewer:shown-action-groups";

/** A nested tree — `call@1` (a step) parenting `call@2` (click, `#checkout`)
 * and `call@4` (a failing expect) — for the ancestor-visibility and
 * collapse-chevron cases the flat fixture can't exercise. */
function nestedModel() {
  return makeModel({
    actions: [
      makeAction({
        callId: "call@1",
        method: "step",
        title: "Checkout flow",
        startTime: 1000,
        endTime: 5000,
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        parentId: "call@1",
        startTime: 2000,
        endTime: 2600,
      }),
      makeAction({
        callId: "call@4",
        method: "expect",
        title: 'Expect "toHaveText"',
        params: { selector: "#total" },
        parentId: "call@1",
        startTime: 3000,
        endTime: 4000,
        error: { name: "Error", message: "expect failed: total mismatch" },
      }),
    ],
  });
}

function optionRow(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[role="option"]');
  if (!row) throw new Error(`no option row for "${text}"`);
  return row as HTMLElement;
}

const noop = () => {
  /* default onSelect for renders that don't assert selection */
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ActionList — grouped actions hidden by default", () => {
  it("renders non-grouped rows and hides the route-grouped action", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("Navigate to app")).toBeTruthy();
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
    expect(screen.queryByText("Route.continue")).toBeNull();
  });

  it("shows a chip with the hidden group's count", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    const chip = screen.getByRole("button", { name: /route 1/i });
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking the chip reveals the row and persists the choice to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    expect(screen.queryByText("Route.continue")).toBeNull();

    await user.click(screen.getByRole("button", { name: /route 1/i }));

    expect(screen.getByText("Route.continue")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /route 1/i })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      JSON.parse(window.localStorage.getItem(SHOWN_GROUPS_KEY) ?? "[]"),
    ).toEqual(["route"]);
  });
});

describe("ActionList — selection", () => {
  it("clicking a row calls onSelect with its call id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByText("Click checkout"));
    expect(onSelect).toHaveBeenCalledWith("call@2");
  });

  it("marks the selected row aria-selected and leaves others unselected", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId="call@2"
        onSelect={noop}
      />,
    );
    expect(optionRow("Click checkout").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(optionRow("Navigate to app").getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("ArrowDown on the listbox moves selection to the next visible row", () => {
    const onSelect = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId="call@1"
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("call@2");
  });
});

describe("ActionList — search", () => {
  const search = () =>
    screen.getByRole("searchbox", { name: "Filter actions" });

  it("narrows to title matches", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    await user.type(search(), "checkout");
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.queryByText("Navigate to app")).toBeNull();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
  });

  it("matches by selector param text (#checkout)", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    await user.type(search(), "#checkout");
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.queryByText("Navigate to app")).toBeNull();
  });

  it("keeps ancestors of a match visible", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={nestedModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    await user.type(search(), "#checkout");
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText("Checkout flow")).toBeTruthy(); // ancestor, no own match
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
  });

  it("clearing the query restores the full list", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    await user.type(search(), "checkout");
    await user.clear(search());
    expect(screen.getByText("Navigate to app")).toBeTruthy();
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
  });

  it("shows the empty note when nothing matches", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    await user.type(search(), "no-such-action-zzz");
    expect(screen.getByText("No actions recorded in this trace.")).toBeTruthy();
  });
});

describe("ActionList — collapse", () => {
  it("the chevron hides descendants, and toggling again reveals them", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={nestedModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("Click checkout")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText("Click checkout")).toBeNull();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Click checkout")).toBeTruthy();
  });
});

describe("ActionList — failure indicator", () => {
  it("the failing action renders an error icon", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
      />,
    );
    const row = optionRow('Expect "toHaveText"');
    expect(row.querySelector("svg.text-fail")).not.toBeNull();
    expect(
      optionRow("Navigate to app").querySelector("svg.text-fail"),
    ).toBeNull();
  });
});
