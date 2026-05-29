import type React from "react";
import { cn } from "@/lib/cn";

interface KpiInlineProps {
  label: string;
  value: React.ReactNode;
  /** Tint applied to the value (e.g. var(--flaky) for flake rate). */
  accent?: string;
  className?: string;
}

/**
 * Compact inline KPI cell — used in a horizontal strip above lists (flaky
 * tests, tests catalog). Mirrors the design bundle's `KPIInline` from
 * `screen-flaky-tests.jsx`: small uppercase tracked label, large mono
 * tabular-num value with -0.2 letter-spacing, vertical divider on the right.
 */
export function KpiInline({ label, value, accent, className }: KpiInlineProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-r border-border pr-3 mr-1 py-1",
        className,
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
        {label}
      </span>
      <span
        className="font-mono text-[16px] font-semibold tracking-[-0.2px] tabular-nums text-foreground"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
    </div>
  );
}
