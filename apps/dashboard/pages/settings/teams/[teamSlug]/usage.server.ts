import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { formatBytes, loadTeamUsage } from "@/lib/usage";
import { requireMemberScope } from "@/lib/settings-scope";

export type UsageRowTone = "ok" | "warn" | "over";

export interface UsageRow {
  key: "runs" | "testResults" | "artifactBytes";
  label: string;
  usedLabel: string;
  limitLabel: string;
  /** 0–100, capped — drives the bar width. `null` when the limit is unlimited. */
  pct: number | null;
  tone: UsageRowTone;
}

export type Props = InferProps<typeof loader>;

/**
 * Settings → Team → Usage. Current billing-period meter (runs, test results,
 * artifact storage) against the team's tier limits. Any member can view it.
 *
 * All display formatting (byte units, percentages, tone) is computed here in the
 * server-only loader so the page component stays purely presentational and free
 * of the `@/lib/usage` import graph (which pulls in `db`/`env`).
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireMemberScope(c);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const usage = await loadTeamUsage(team.id, nowSeconds);
  const warnPct = env.WRIGHTFUL_QUOTA_SOFT_WARN_PCT;

  const row = (
    key: UsageRow["key"],
    label: string,
    used: number,
    limit: number,
    fmt: (n: number) => string,
  ): UsageRow => {
    if (!Number.isFinite(limit)) {
      return {
        key,
        label,
        usedLabel: fmt(used),
        limitLabel: "Unlimited",
        pct: null,
        tone: "ok",
      };
    }
    const rawPct = limit > 0 ? (used / limit) * 100 : 100;
    const pct = Math.min(100, Math.round(rawPct));
    const tone: UsageRowTone =
      rawPct >= 100 ? "over" : rawPct >= warnPct ? "warn" : "ok";
    return {
      key,
      label,
      usedLabel: fmt(used),
      limitLabel: fmt(limit),
      pct,
      tone,
    };
  };

  const fmtNum = (n: number) => n.toLocaleString("en-US");

  return {
    team,
    tier: usage.tier,
    periodStart: usage.periodStart,
    artifactCount: usage.artifactCount,
    rows: [
      row("runs", "Runs", usage.runsCount, usage.limits.runs, fmtNum),
      row(
        "testResults",
        "Test results",
        usage.testResultsCount,
        usage.limits.testResults,
        fmtNum,
      ),
      row(
        "artifactBytes",
        "Artifact storage",
        usage.artifactBytes,
        usage.limits.artifactBytes,
        formatBytes,
      ),
    ],
  };
});
