import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FlakyTestRow,
  type FlakyRecentFailure,
} from "@/app/components/flaky-test-row";

const baseProps = {
  rank: 1,
  testId: "t1",
  title: "broken-on-tuesdays",
  file: "src/foo.spec.ts",
  total: 100,
  flakyCount: 7,
  pct: 7,
  sparklinePoints: [{ status: "passed" }, { status: "flaky" }],
  recentFailures: [] as FlakyRecentFailure[],
  projectBase: "/t/acme/p/web",
  historyHref: "/t/acme/p/web/tests/t1",
};

function tableWrap(children: React.ReactNode) {
  return (
    <table>
      <tbody>{children}</tbody>
    </table>
  );
}

describe("FlakyTestRow", () => {
  it("renders rank, title, file, percentage, and ratio", () => {
    render(tableWrap(<FlakyTestRow {...baseProps} />));
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("broken-on-tuesdays")).toBeInTheDocument();
    expect(screen.getByText("src/foo.spec.ts")).toBeInTheDocument();
    expect(screen.getByText("7.0%")).toBeInTheDocument();
    expect(screen.getByText("7 / 100")).toBeInTheDocument();
  });

  it("starts collapsed (no recent-failures panel visible)", () => {
    render(
      tableWrap(
        <FlakyTestRow
          {...baseProps}
          recentFailures={[
            {
              testResultId: "tr-1",
              runId: "run-1",
              commitSha: "abcdef1234",
              branch: "main",
              createdAt: 1_700_000_000,
              errorMessage: "fail",
              errorStack: null,
            },
          ]}
        />,
      ),
    );
    expect(screen.queryByText(/Recent Failures/i)).not.toBeInTheDocument();
  });

  it("expands the recent-failures panel on row click", async () => {
    const user = userEvent.setup();
    render(
      tableWrap(
        <FlakyTestRow
          {...baseProps}
          recentFailures={[
            {
              testResultId: "tr-1",
              runId: "run-1",
              commitSha: "abcdef1234",
              branch: "main",
              createdAt: 1_700_000_000,
              errorMessage: "fail",
              errorStack: null,
            },
          ]}
        />,
      ),
    );

    // Row click target = the rank cell row (clicking the title link is intercepted).
    await user.click(screen.getByText("#1"));
    expect(screen.getByText(/Recent Failures \(1\)/i)).toBeInTheDocument();
  });

  it("renders 'No recent failures captured' when expanded with empty failures", async () => {
    const user = userEvent.setup();
    render(tableWrap(<FlakyTestRow {...baseProps} />));
    await user.click(screen.getByText("#1"));
    expect(
      screen.getByText(/No recent failures captured/i),
    ).toBeInTheDocument();
  });

  it("composes per-failure links as `${projectBase}/runs/:runId/tests/:trId?attempt=0`", async () => {
    const user = userEvent.setup();
    render(
      tableWrap(
        <FlakyTestRow
          {...baseProps}
          recentFailures={[
            {
              testResultId: "tr-99",
              runId: "run-42",
              commitSha: null,
              branch: null,
              createdAt: 1_700_000_000,
              errorMessage: null,
              errorStack: null,
            },
          ]}
        />,
      ),
    );
    await user.click(screen.getByText("#1"));
    const links = screen.getAllByRole("link");
    const failureLink = links.find((l) =>
      l.getAttribute("href")?.includes("run-42"),
    );
    expect(failureLink?.getAttribute("href")).toBe(
      "/t/acme/p/web/runs/run-42/tests/tr-99?attempt=0",
    );
  });

  it("uses commitSha (first 7) as the failure label, falling back to runId (first 8)", async () => {
    const user = userEvent.setup();
    render(
      tableWrap(
        <FlakyTestRow
          {...baseProps}
          recentFailures={[
            {
              testResultId: "tr-1",
              runId: "01HRUNxxxxxxxxxxxxxxxxxxxx",
              commitSha: "deadbeefcafe",
              branch: "feat",
              createdAt: 1_700_000_000,
              errorMessage: null,
              errorStack: null,
            },
            {
              testResultId: "tr-2",
              runId: "01HJUNxxxxxxxxxxxxxxxxxxxx",
              commitSha: null,
              branch: null,
              createdAt: 1_700_000_100,
              errorMessage: null,
              errorStack: null,
            },
          ]}
        />,
      ),
    );
    await user.click(screen.getByText("#1"));
    expect(screen.getByText(/Run deadbee/)).toBeInTheDocument();
    expect(screen.getByText(/Run 01HJUNxx/)).toBeInTheDocument();
  });

  it("uses tone classes that escalate with pct (20%+ destructive, 5–20% warning, <5% muted)", () => {
    const view = render(tableWrap(<FlakyTestRow {...baseProps} pct={3} />));
    expect(view.container.querySelector(".border-l-border")).toBeTruthy();
    view.unmount();

    const view2 = render(tableWrap(<FlakyTestRow {...baseProps} pct={10} />));
    expect(view2.container.querySelector(".border-l-warning")).toBeTruthy();
    view2.unmount();

    const view3 = render(tableWrap(<FlakyTestRow {...baseProps} pct={42} />));
    expect(view3.container.querySelector(".border-l-destructive")).toBeTruthy();
  });

  it("title link does not bubble to the row toggle (clicking title navigates, not expands)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      tableWrap(
        <FlakyTestRow
          {...baseProps}
          recentFailures={[
            {
              testResultId: "tr-1",
              runId: "run-1",
              commitSha: null,
              branch: null,
              createdAt: 1_700_000_000,
              errorMessage: null,
              errorStack: null,
            },
          ]}
        />,
      ),
    );
    const titleLink = within(container).getByText("broken-on-tuesdays");
    await user.click(titleLink);
    expect(screen.queryByText(/Recent Failures/i)).not.toBeInTheDocument();
  });
});
