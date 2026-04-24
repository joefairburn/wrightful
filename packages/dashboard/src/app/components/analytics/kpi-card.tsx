import type { LucideIcon } from "lucide-react";
import { Card } from "@/app/components/ui/card";

export interface AnalyticsKpiCardProps {
  label: string;
  value: string;
  Icon: LucideIcon;
  iconColor?: string;
  footnote?: string;
}

export function AnalyticsKpiCard({
  label,
  value,
  Icon,
  iconColor = "var(--color-muted-foreground)",
  footnote,
}: AnalyticsKpiCardProps) {
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-start justify-between">
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <Icon size={18} style={{ color: iconColor }} />
        </div>
        <div className="mt-3 font-mono text-3xl tracking-tight text-foreground">
          {value}
        </div>
        {footnote && (
          <div className="mt-2 font-mono text-[11px] text-muted-foreground">
            {footnote}
          </div>
        )}
      </div>
    </Card>
  );
}
