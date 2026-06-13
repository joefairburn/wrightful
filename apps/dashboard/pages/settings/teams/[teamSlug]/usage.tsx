import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { cn } from "@/lib/cn";
import type { Props, UsageRow, UsageRowTone } from "./usage.server";

const TONE_BAR: Record<UsageRowTone, string> = {
  ok: "bg-accent",
  warn: "bg-warning",
  over: "bg-fail",
};

function UsageMeter({ row }: { row: UsageRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-[length:var(--text-fs-13)] text-fg-1">
          {row.label}
        </span>
        <span className="font-mono text-[11px] text-fg-3 tabular-nums">
          {row.usedLabel} / {row.limitLabel}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3"
        aria-hidden
      >
        {row.pct !== null && (
          <div
            className={cn(
              "h-full rounded-full transition-all",
              TONE_BAR[row.tone],
            )}
            style={{ width: `${row.pct}%` }}
          />
        )}
      </div>
      {row.tone === "over" && (
        <span className="text-[11px] text-fail">
          Over the plan limit — new {row.label.toLowerCase()} are blocked until
          the next billing period.
        </span>
      )}
    </div>
  );
}

/**
 * Settings → Team → Usage. Read-only meter for the current billing period.
 * Purely presentational — all formatting/tone is computed in `usage.server.ts`.
 */
export default function SettingsTeamUsagePage({
  team,
  tier,
  periodStart,
  artifactCount,
  rows,
}: Props) {
  const periodLabel = new Date(periodStart * 1000).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · Usage`}
        subtitle={`Usage for ${periodLabel}, against the ${tier} plan. Resets at the start of each month.`}
      />

      <SettingsCard title="This billing period">
        <div className="flex flex-col gap-5">
          {rows.map((row) => (
            <UsageMeter key={row.key} row={row} />
          ))}
          <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
            <span className="font-mono tabular-nums">
              {artifactCount.toLocaleString("en-US")}
            </span>{" "}
            artifacts stored this period.
          </p>
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
