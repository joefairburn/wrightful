import type { VariantProps } from "class-variance-authority";
import { Badge, badgeVariants } from "@/app/components/ui/badge";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  passed: "success",
  failed: "error",
  timedout: "error",
  flaky: "warning",
  interrupted: "warning",
  skipped: "secondary",
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"}>
      {status.toUpperCase()}
    </Badge>
  );
}
