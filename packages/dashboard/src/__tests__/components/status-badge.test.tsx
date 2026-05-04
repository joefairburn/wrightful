import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/app/components/status-badge";

describe("StatusBadge", () => {
  it("renders the status text in upper case", () => {
    render(<StatusBadge status="passed" />);
    expect(screen.getByText("PASSED")).toBeInTheDocument();
  });

  it("uses the success variant for 'passed'", () => {
    render(<StatusBadge status="passed" />);
    expect(screen.getByText("PASSED").className).toMatch(/success/);
  });

  it("uses the error variant for 'failed' and 'timedout'", () => {
    const { unmount } = render(<StatusBadge status="failed" />);
    expect(screen.getByText("FAILED").className).toMatch(/destructive/);
    unmount();
    render(<StatusBadge status="timedout" />);
    expect(screen.getByText("TIMEDOUT").className).toMatch(/destructive/);
  });

  it("uses the warning variant for flaky/interrupted", () => {
    const { unmount } = render(<StatusBadge status="flaky" />);
    expect(screen.getByText("FLAKY").className).toMatch(/warning/);
    unmount();
    render(<StatusBadge status="interrupted" />);
    expect(screen.getByText("INTERRUPTED").className).toMatch(/warning/);
  });

  it("falls back to outline variant for unknown statuses", () => {
    render(<StatusBadge status="weird-state" />);
    const el = screen.getByText("WEIRD-STATE");
    // Outline variant uses border-input class — distinct from the warn/error classes.
    expect(el.className).toMatch(/border-input/);
  });
});
