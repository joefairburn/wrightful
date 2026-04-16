import { statusColor } from "@/lib/status";

interface StatusBadgeProps {
  status: string;
}

/** Uppercased coloured text badge. Intentionally minimal — if we ever want a
 * pill/background treatment, change it once here. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span style={{ color: statusColor(status) }}>{status.toUpperCase()}</span>
  );
}
