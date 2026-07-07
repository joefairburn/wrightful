import * as React from "react";
import {
  Tooltip,
  TooltipCreateHandle,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

type ChartTooltipHandle = ReturnType<
  typeof TooltipCreateHandle<React.ReactNode>
>;

const ChartTooltipContext = React.createContext<ChartTooltipHandle | null>(
  null,
);

/**
 * Owns the single tooltip shared by all columns of a chart (Base UI
 * "detached triggers"): every `ChartColumnTooltip` is a trigger on one
 * handle, so the popup stays mounted and glides between column anchors as
 * the pointer moves across the plot — the positioner/viewport transition
 * classes in `ui/tooltip` animate position and crossfade content — instead
 * of closing and reopening per column. `widthClass` fixes the content width
 * so `justify-between` rows keep their spread.
 */
export function ChartTooltipProvider({
  widthClass,
  children,
}: {
  widthClass: string;
  children: React.ReactNode;
}) {
  const [handle] = React.useState(() => TooltipCreateHandle<React.ReactNode>());
  return (
    <ChartTooltipContext.Provider value={handle}>
      {children}
      <Tooltip handle={handle}>
        {({ payload }) => (
          // `glide`: the popup stays mounted and eases between column anchors,
          // swapping content instantly. A crossfade while sweeping bars keeps
          // the values mid-fade (reads as flicker); the positional glide still
          // animates.
          <TooltipPopup glide>
            <div className={cn(widthClass, "py-1")}>{payload}</div>
          </TooltipPopup>
        )}
      </Tooltip>
    </ChartTooltipContext.Provider>
  );
}

/**
 * Per-column chart tooltip trigger. A full-height column hitbox — inside the
 * charts' `pointer-events-none` hover row it re-enables pointer events, so
 * hover works even where the mark itself is very thin. The shared popup
 * portals to the body, so ancestor `overflow-hidden` cards never clip it.
 */
export function ChartColumnTooltip({ tooltip }: { tooltip: React.ReactNode }) {
  const handle = React.useContext(ChartTooltipContext);
  if (!handle) throw new Error("ChartColumnTooltip needs ChartTooltipProvider");
  return (
    <TooltipTrigger
      closeDelay={200}
      delay={0}
      handle={handle}
      payload={tooltip}
      render={<div className="pointer-events-auto absolute inset-0" />}
    />
  );
}
