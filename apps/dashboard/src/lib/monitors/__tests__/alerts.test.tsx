import { describe, expect, it, vi } from "vite-plus/test";
import { MonitorAlert } from "@/emails/monitor-alert";
import { listTeamMembers } from "@/lib/auth-users";
import {
  classifyAlert,
  type ExecutionTimelineRow,
  findLastPassAt,
  sendMonitorAlert,
  shouldSendAlert,
  summarizeRecovery,
} from "@/lib/monitors/alerts";
import { runMonitorJob, type RunMonitorJobDeps } from "@/lib/monitors/executor";
import { renderEmail } from "@/lib/render-email";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
} from "@/lib/monitors/types";

// `sendMonitorAlert` short-circuits when email isn't configured (no `EMAIL`
// binding + no `EMAIL_FROM`) BEFORE any recipient/render work. Force the
// unconfigured state, and stub `listTeamMembers` (the first DB-backed call in
// `resolveRecipients`) so the gate test can assert the early return fired
// without touching the DB — if the gate regresses, `listTeamMembers` would be
// invoked even though the eventual return value (0 recipients) is unchanged.
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("void/env", () => ({ env: {} }));
vi.mock("@/lib/auth-users", () => ({
  listTeamMembers: vi.fn(() => Promise.resolve([])),
}));

describe("classifyAlert", () => {
  it("alerts on a healthy→down transition (incl. first-ever result)", () => {
    expect(classifyAlert(null, "fail")).toBe("down");
    expect(classifyAlert(null, "error")).toBe("down");
    expect(classifyAlert("pass", "fail")).toBe("down");
    expect(classifyAlert("degraded", "error")).toBe("down");
  });

  it("alerts recovery on a down→healthy transition", () => {
    expect(classifyAlert("fail", "pass")).toBe("recovery");
    expect(classifyAlert("error", "pass")).toBe("recovery");
    expect(classifyAlert("fail", "degraded")).toBe("recovery");
  });

  it("stays silent without an edge (still-down, still-healthy, degraded churn)", () => {
    expect(classifyAlert("fail", "fail")).toBeNull();
    expect(classifyAlert("fail", "error")).toBeNull();
    expect(classifyAlert(null, "pass")).toBeNull();
    expect(classifyAlert("pass", "pass")).toBeNull();
    expect(classifyAlert("pass", "degraded")).toBeNull();
  });
});

describe("shouldSendAlert", () => {
  const enabled = { alertsEnabled: 1 } as Monitor;
  const muted = { alertsEnabled: 0 } as Monitor;

  it("classifies the transition when alerts are enabled", () => {
    expect(shouldSendAlert(enabled, "pass", "fail")).toBe("down");
    expect(shouldSendAlert(enabled, "fail", "pass")).toBe("recovery");
    expect(shouldSendAlert(enabled, "pass", "pass")).toBeNull();
  });

  it("never alerts when the monitor's alerts are muted", () => {
    expect(shouldSendAlert(muted, "pass", "fail")).toBeNull();
    expect(shouldSendAlert(muted, "fail", "pass")).toBeNull();
  });
});

describe("incident summaries (from execution history, newest-first)", () => {
  // Same epoch-seconds for created/started/completed keeps the math obvious.
  const row = (state: string, t: number): ExecutionTimelineRow => ({
    state,
    createdAt: t,
    startedAt: t,
    completedAt: t,
  });

  describe("findLastPassAt", () => {
    it("returns the most recent pass strictly before the trigger row", () => {
      expect(
        findLastPassAt([
          row("fail", 1000),
          row("error", 940),
          row("pass", 880),
          row("pass", 820),
        ]),
      ).toBe(880);
    });

    it("skips non-terminal (queued/running) rows", () => {
      expect(
        findLastPassAt([
          row("fail", 1000),
          row("running", 990),
          row("pass", 940),
        ]),
      ).toBe(940);
    });

    it("is null when no prior pass is in the window", () => {
      expect(findLastPassAt([row("fail", 1000), row("fail", 940)])).toBeNull();
    });
  });

  describe("summarizeRecovery", () => {
    it("counts the just-ended failing streak and its duration", () => {
      expect(
        summarizeRecovery([
          row("pass", 1000),
          row("fail", 940),
          row("fail", 880),
          row("pass", 820),
        ]),
      ).toEqual({ recoveredAt: 1000, downtimeSeconds: 120, failedChecks: 2 });
    });

    it("reports no downtime when nothing failed before the pass", () => {
      expect(summarizeRecovery([row("pass", 1000), row("pass", 940)])).toEqual({
        recoveredAt: 1000,
        downtimeSeconds: null,
        failedChecks: 0,
      });
    });

    it("ignores non-terminal rows between the recovery and the streak", () => {
      expect(
        summarizeRecovery([
          row("pass", 1000),
          row("running", 990),
          row("fail", 940),
          row("pass", 880),
        ]),
      ).toEqual({ recoveredAt: 1000, downtimeSeconds: 60, failedChecks: 1 });
    });

    it("is null without any terminal execution", () => {
      expect(summarizeRecovery([row("running", 1000)])).toBeNull();
    });
  });
});

describe("MonitorAlert template", () => {
  it("renders a down alert with the name, error detail, and a deep link", async () => {
    const { html } = await renderEmail(
      <MonitorAlert
        kind="down"
        monitorName="Checkout flow"
        state="fail"
        errorMessage="HTTP 500 from /checkout"
        url="https://app.example.com/t/acme/p/web/monitors/m1"
      />,
    );
    expect(html).toContain("Checkout flow");
    expect(html).toContain("Monitor down");
    expect(html).toContain("HTTP 500 from /checkout");
    expect(html).toContain("https://app.example.com/t/acme/p/web/monitors/m1");
  });

  it("renders a recovery alert", async () => {
    const { html } = await renderEmail(
      <MonitorAlert kind="recovery" monitorName="Checkout flow" state="pass" />,
    );
    expect(html).toContain("recovered");
  });
});

describe("runMonitorJob alert wiring", () => {
  const monitor = {
    id: "m1",
    projectId: "p1",
    teamId: "t1",
    name: "X",
    lastStatus: "pass",
    alertsEnabled: 1,
  } as Monitor;
  const execution = {
    id: "e1",
    projectId: "p1",
    monitorId: "m1",
    createdAt: 1,
  } as MonitorExecution;
  const failResult: ExecutionResult = {
    state: "fail",
    runId: null,
    durationMs: 10,
    errorMessage: "down",
    infraError: false,
    statusCode: 500,
    resultDetail: null,
  };

  function makeDeps(alert: RunMonitorJobDeps["alert"]): RunMonitorJobDeps {
    return {
      loadExecution: () => Promise.resolve(execution),
      loadMonitor: () => Promise.resolve(monitor),
      claim: () => Promise.resolve(true),
      recordResult: () => Promise.resolve(),
      executor: { execute: () => Promise.resolve(failResult) },
      now: () => 100,
      broadcast: () => Promise.resolve(),
      alert,
    };
  }

  const JOB = { monitorId: "m1", executionId: "e1", scheduledFor: 1 };

  it("invokes the alert dep with the PRIOR status after recording", async () => {
    const alert = vi.fn(() => Promise.resolve());
    const outcome = await runMonitorJob(JOB, makeDeps(alert));

    expect(outcome).toEqual({ action: "ack" });
    // prevStatus is the monitor's lastStatus captured before recordResult.
    expect(alert).toHaveBeenCalledWith(monitor, failResult, "pass");
  });

  it("swallows an alert failure without changing the ack outcome", async () => {
    const alert = vi.fn(() => Promise.reject(new Error("alert boom")));
    const outcome = await runMonitorJob(JOB, makeDeps(alert));

    expect(outcome).toEqual({ action: "ack" });
  });
});

describe("sendMonitorAlert email gating", () => {
  const monitor = {
    id: "m1",
    teamId: "t1",
    projectId: "p1",
    name: "X",
    alertTargets: null,
  } as Monitor;
  const result: ExecutionResult = {
    state: "fail",
    runId: null,
    durationMs: 10,
    errorMessage: "down",
    infraError: false,
    statusCode: 500,
    resultDetail: null,
  };

  it("returns 0 and resolves no recipients when email isn't configured", async () => {
    expect(await sendMonitorAlert(monitor, result, "down")).toBe(0);
    // The gate must fire before any DB work — `resolveRecipients` is skipped.
    expect(vi.mocked(listTeamMembers)).not.toHaveBeenCalled();
  });
});
