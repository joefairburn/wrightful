/**
 * Monitor down/recovery email alerts. Fired from the queue consumer's
 * `runMonitorJob` right after a result is recorded (injected as the `alert`
 * dep, mirroring `broadcast`). Edge-triggered: an alert is sent only on a
 * health TRANSITION, so a monitor that stays down doesn't email every interval.
 *
 * The pure decision (`shouldSendAlert`) is separated from the IO
 * (`sendMonitorAlert`) so the policy is unit-testable without the `void/db` /
 * email runtime. The whole path is best-effort: `maybeSendMonitorAlert` catches
 * + logs and never throws into the monitor pipeline (the result is already
 * persisted), and when email isn't configured `sendEmail` is a graceful no-op.
 *
 * v1 gaps (intentional): the reaper (`sweepStaleExecutions`) doesn't run through
 * `runMonitorJob` and deliberately leaves `lastStatus` untouched, so executions
 * it flips to `error` don't alert. Recipients are all team members (no per-alert
 * recipient list yet).
 */
import { and, db, desc, eq } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { monitorExecutions, projects, teams } from "@schema";
import { listTeamMembers } from "@/lib/auth-users";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { MonitorAlert } from "@/emails/monitor-alert";
import {
  parseAlertTargets,
  resolveTargetUserIds,
} from "@/lib/monitors/alert-targets";
import { listUserIdsInGroups } from "@/lib/member-groups";
import { renderEmail } from "@/lib/render-email";
import type {
  ExecutionResult,
  Monitor,
  TerminalExecutionState,
} from "@/lib/monitors/types";

/** Which alert a transition warrants, if any. */
export type AlertKind = "down" | "recovery";

/** Terminal states that mean "the monitor is down". `degraded` is a warning, not down. */
const DOWN_STATES: ReadonlySet<string> = new Set(["fail", "error"]);

function isDown(status: string | null): boolean {
  return status !== null && DOWN_STATES.has(status);
}

/** Settled states — `queued`/`running` rows are noise for incident math. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "pass",
  "degraded",
  "fail",
  "error",
]);

/**
 * The execution-history fields the incident-summary helpers read. Timestamps
 * are epoch SECONDS (the scheduler's clock); `startedAt`/`completedAt` are null
 * until the attempt is claimed/recorded, so callers fall back to `createdAt`.
 */
export interface ExecutionTimelineRow {
  state: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** When the attempt ran (≈ claim time), falling back to enqueue time. */
function ranAt(e: ExecutionTimelineRow): number {
  return e.startedAt ?? e.createdAt;
}
/** When the attempt settled, falling back to run/enqueue time. */
function settledAt(e: ExecutionTimelineRow): number {
  return e.completedAt ?? e.startedAt ?? e.createdAt;
}

/**
 * Epoch-seconds of the most recent PASS strictly older than the triggering
 * (newest terminal) execution, or null if none is in the window. Powers the
 * down alert's "last passed" line — meaningful because the down alert is
 * edge-triggered (consecutive-failure counts would always be 1 at send time).
 * Pure; `executions` must be newest-first.
 */
export function findLastPassAt(
  executions: ExecutionTimelineRow[],
): number | null {
  const terminal = executions.filter((e) => TERMINAL_STATES.has(e.state));
  for (const e of terminal.slice(1)) {
    if (e.state === "pass") return settledAt(e);
  }
  return null;
}

/**
 * Summarize the just-ended outage from the recovery alert's vantage: the newest
 * terminal execution is the recovering one, and the run of down (fail|error)
 * rows immediately preceding it is the incident. `downtimeSeconds` spans the
 * first failure's run time → the recovery's settle time. Pure; newest-first.
 * Returns null if there's no terminal execution yet.
 */
export function summarizeRecovery(executions: ExecutionTimelineRow[]): {
  recoveredAt: number;
  downtimeSeconds: number | null;
  failedChecks: number;
} | null {
  const terminal = executions.filter((e) => TERMINAL_STATES.has(e.state));
  const recovery = terminal[0];
  if (!recovery) return null;
  const streak: ExecutionTimelineRow[] = [];
  for (const e of terminal.slice(1)) {
    if (DOWN_STATES.has(e.state)) streak.push(e);
    else break;
  }
  const recoveredAt = settledAt(recovery);
  if (streak.length === 0) {
    return { recoveredAt, downtimeSeconds: null, failedChecks: 0 };
  }
  const firstFailure = streak[streak.length - 1];
  return {
    recoveredAt,
    downtimeSeconds: Math.max(0, recoveredAt - ranAt(firstFailure)),
    failedChecks: streak.length,
  };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Epoch-seconds → "Jun 15, 14:32 UTC". Manual (no ICU variance across hosts). */
function formatUtc(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** Seconds → compact duration, e.g. "1h 5m" / "35m 12s" / "45s". */
function formatDowntime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Classify a status transition into an alert, or `null` for no-alert. Pure.
 *   - healthy → down  ⇒ "down"      (incl. the first-ever result being down)
 *   - down → healthy  ⇒ "recovery"
 *   - everything else ⇒ null        (still-down, still-healthy, degraded churn)
 *
 * "down" = fail|error; "healthy" = anything else (pass|degraded|null/unknown).
 * Edge-triggered on the down boundary, so a flap between fail and degraded
 * doesn't double-alert.
 */
export function classifyAlert(
  prev: string | null,
  next: TerminalExecutionState,
): AlertKind | null {
  const wasDown = isDown(prev);
  const nowDown = isDown(next);
  if (!wasDown && nowDown) return "down";
  if (wasDown && !nowDown) return "recovery";
  return null;
}

/**
 * The pure send DECISION: respects the monitor's `alertsEnabled` flag, then
 * classifies the transition. No IO — unit-testable on its own.
 */
export function shouldSendAlert(
  monitor: Monitor,
  prev: string | null,
  next: TerminalExecutionState,
): AlertKind | null {
  if (monitor.alertsEnabled !== 1) return null;
  return classifyAlert(prev, next);
}

/**
 * Resolve the email addresses an alert is delivered to, honoring the monitor's
 * `alertTargets`: `null` ⇒ all team members; else the selected members + the
 * members of the selected groups, intersected with the team's LIVE members
 * (`resolveTargetUserIds`) so a removed member or deleted group can't leak.
 */
async function resolveRecipients(monitor: Monitor): Promise<string[]> {
  const members = await listTeamMembers(monitor.teamId);
  const targets = parseAlertTargets(monitor.alertTargets);
  const groupUserIds =
    targets && targets.groups.length > 0
      ? await listUserIdsInGroups(monitor.teamId, targets.groups)
      : [];
  const wanted = new Set(
    resolveTargetUserIds(
      targets,
      members.map((m) => m.userId),
      groupUserIds,
    ),
  );
  return members
    .filter((m) => wanted.has(m.userId))
    .map((m) => m.email)
    .filter(Boolean);
}

/**
 * The team name (for the email header) + best-effort deep links to the monitor
 * detail page and (for browser executions) the triggering run report. One query
 * serves all three; the links are null when `WRIGHTFUL_PUBLIC_URL` is unset (or
 * `runId` is absent), but the team name is still resolved.
 */
async function resolveMonitorMeta(
  monitor: Monitor,
  runId: string | null,
): Promise<{
  url: string | null;
  runUrl: string | null;
  teamName: string | null;
}> {
  const rows = await db
    .select({
      teamSlug: teams.slug,
      teamName: teams.name,
      projectSlug: projects.slug,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, monitor.projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return { url: null, runUrl: null, teamName: null };
  const base = env.WRIGHTFUL_PUBLIC_URL?.replace(/\/$/, "");
  const prefix = base ? `${base}/t/${row.teamSlug}/p/${row.projectSlug}` : null;
  return {
    url: prefix ? `${prefix}/monitors/${monitor.id}` : null,
    runUrl: prefix && runId ? `${prefix}/runs/${runId}` : null,
    teamName: row.teamName,
  };
}

/**
 * Recent terminal-or-not executions for a monitor, newest first — the input to
 * the incident-summary helpers. Scoped by `projectId` + `monitorId` (the
 * `monitorExecutions_monitor_created_at_idx` access path). The window bounds the
 * outage math: a streak longer than `limit` saturates the count.
 */
function loadRecentExecutions(
  monitor: Monitor,
  limit: number,
): Promise<ExecutionTimelineRow[]> {
  return db
    .select({
      state: monitorExecutions.state,
      createdAt: monitorExecutions.createdAt,
      startedAt: monitorExecutions.startedAt,
      completedAt: monitorExecutions.completedAt,
    })
    .from(monitorExecutions)
    .where(
      and(
        eq(monitorExecutions.projectId, monitor.projectId),
        eq(monitorExecutions.monitorId, monitor.id),
      ),
    )
    .orderBy(desc(monitorExecutions.createdAt))
    .limit(limit);
}

/** History window for incident math — ~16h at a 5-min cadence (see saturation note). */
const ALERT_HISTORY_LIMIT = 200;

/**
 * Render + send the alert email to the team. Best-effort: a transport failure
 * or a misconfigured sender propagates to the caller (which logs it); a missing
 * sender makes `sendEmail` a no-op. Returns the recipient count (0 = skipped).
 */
export async function sendMonitorAlert(
  monitor: Monitor,
  result: ExecutionResult,
  kind: AlertKind,
): Promise<number> {
  // Email off (no binding / no EMAIL_FROM) ⇒ skip before doing any work. The
  // recipient/url reads + the two React-Email renders below would all be
  // discarded by `sendEmail`'s graceful no-op, so short-circuit here.
  if (!isEmailConfigured()) return 0;

  const recipients = await resolveRecipients(monitor);
  if (recipients.length === 0) return 0;

  const { url, runUrl, teamName } = await resolveMonitorMeta(
    monitor,
    result.runId,
  );

  // Incident metrics derived from execution history. The down alert is
  // edge-triggered (fires only at the first failure), so "consecutive failures"
  // would always be 1 — instead we surface when it last passed. The recovery
  // alert sees a real outage behind it, so we summarize its length + duration.
  const history = await loadRecentExecutions(monitor, ALERT_HISTORY_LIMIT);
  const recovery = kind === "recovery" ? summarizeRecovery(history) : null;
  const lastPassedAtSec = kind === "down" ? findLastPassAt(history) : null;

  const { html, text } = await renderEmail(
    <MonitorAlert
      kind={kind}
      monitorName={monitor.name}
      state={result.state}
      errorMessage={result.errorMessage}
      url={url}
      runUrl={runUrl}
      teamName={teamName}
      intervalSeconds={monitor.intervalSeconds}
      lastPassedAt={lastPassedAtSec != null ? formatUtc(lastPassedAtSec) : null}
      recoveredAt={recovery ? formatUtc(recovery.recoveredAt) : null}
      downtime={
        recovery?.downtimeSeconds != null
          ? formatDowntime(recovery.downtimeSeconds)
          : null
      }
      failedChecks={
        recovery && recovery.failedChecks > 0 ? recovery.failedChecks : null
      }
      lastDurationMs={kind === "recovery" ? result.durationMs : null}
    />,
  );
  const subject =
    kind === "down"
      ? `🔴 ${monitor.name} is down`
      : `✅ ${monitor.name} recovered`;

  const sent = await sendEmail({ to: recipients, subject, html, text });
  if (sent.sent) {
    logger.info("monitor alert sent", {
      monitorId: monitor.id,
      kind,
      recipients: recipients.length,
    });
  }
  return recipients.length;
}

/**
 * The injected `alert` effect: decide, then send. Swallows all errors (logs
 * them) so alerting can never change the queue consumer's ack/retry outcome —
 * the same non-fatal contract as `broadcast`.
 */
export async function maybeSendMonitorAlert(
  monitor: Monitor,
  result: ExecutionResult,
  prevStatus: string | null,
): Promise<void> {
  const kind = shouldSendAlert(monitor, prevStatus, result.state);
  if (!kind) return;
  try {
    await sendMonitorAlert(monitor, result, kind);
  } catch (err) {
    logger.error("monitor alert failed", {
      monitorId: monitor.id,
      kind,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
