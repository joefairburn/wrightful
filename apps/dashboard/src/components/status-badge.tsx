import { Badge } from "@/components/ui/badge";
import { statusBadgeVariant, statusLabel } from "@/lib/status";

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <Badge variant={statusBadgeVariant(status)}>{statusLabel(status)}</Badge>
  );
}
