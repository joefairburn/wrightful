"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Minimal two-pane resizable split for the trace workbench (no split-pane
 * component exists in ui/ and pulling a dependency for one divider isn't
 * worth it). The first child gets `fraction` of the container, the second
 * the rest; the divider drags with pointer capture. Fraction is component
 * state only — not persisted.
 */
export function SplitPane({
  direction,
  initial,
  min = 0.15,
  max = 0.85,
  className,
  children,
}: {
  direction: "horizontal" | "vertical";
  /** Initial size of the first pane as a fraction of the container. */
  initial: number;
  min?: number;
  max?: number;
  className?: string;
  children: [React.ReactNode, React.ReactNode];
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = useState(initial);
  const horizontal = direction === "horizontal";

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const divider = event.currentTarget;
      divider.setPointerCapture(event.pointerId);

      const onMove = (move: PointerEvent): void => {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const next = horizontal
          ? (move.clientX - rect.left) / rect.width
          : (move.clientY - rect.top) / rect.height;
        setFraction(Math.min(max, Math.max(min, next)));
      };
      const onUp = (): void => {
        divider.removeEventListener("pointermove", onMove);
        divider.removeEventListener("pointerup", onUp);
      };
      divider.addEventListener("pointermove", onMove);
      divider.addEventListener("pointerup", onUp);
    },
    [horizontal, min, max],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 min-w-0",
        horizontal ? "flex-row" : "flex-col",
        className,
      )}
    >
      <div
        className="min-h-0 min-w-0 shrink-0 grow-0"
        style={{ flexBasis: `${fraction * 100}%` }}
      >
        {children[0]}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        onPointerDown={onPointerDown}
        className={cn(
          "shrink-0 bg-line-1 transition-colors hover:bg-ring/60",
          horizontal ? "w-px cursor-col-resize px-0" : "h-px cursor-row-resize",
          // Widen the hit area without widening the visible line.
          horizontal
            ? "relative after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']"
            : "relative after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-['']",
        )}
      />
      <div className="min-h-0 min-w-0 flex-1">{children[1]}</div>
    </div>
  );
}
