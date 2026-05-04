import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorPage } from "@/app/components/error-page";

describe("ErrorPage", () => {
  it("renders an Error's message", () => {
    render(<ErrorPage error={new Error("Boom")} />);
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });

  it("renders a generic message when error is not an Error instance", () => {
    render(<ErrorPage error="string thrown" />);
    expect(
      screen.getByText("An unexpected error occurred."),
    ).toBeInTheDocument();
  });

  it("includes a 'Go home' link to /", () => {
    render(<ErrorPage error={new Error("x")} />);
    const link = screen.getByRole("link", { name: /go home/i });
    expect(link).toHaveAttribute("href", "/");
  });

  it("renders a heading", () => {
    render(<ErrorPage error={new Error("x")} />);
    expect(
      screen.getByRole("heading", { name: /something went wrong/i }),
    ).toBeInTheDocument();
  });
});
