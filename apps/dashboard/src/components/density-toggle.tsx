import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useState } from "react";
import { applyDensity, isCompactApplied, persistDensity } from "@/lib/density";
import { cn } from "@/lib/cn";

/**
 * Density sibling of `ThemeToggle`. Reads the current density from
 * `<html class>` on mount (which the inline script in `middleware/01.head.ts`
 * has already set from localStorage), then mirrors changes back to both the
 * class and localStorage on toggle.
 *
 * Keeping the source-of-truth on `document.documentElement.classList` rather
 * than React state means a useEffect-driven hydration mismatch can't flash the
 * wrong icon: we read whatever the FOUC-killer script chose.
 */
export function DensityToggle({
  variant = "menu-row",
}: {
  variant?: "menu-row" | "icon-button";
}) {
  const [isCompact, setIsCompact] = useState<boolean | null>(null);

  useEffect(() => {
    setIsCompact(isCompactApplied());
  }, []);

  const toggle = () => {
    const next = !isCompactApplied();

    // Suppress every transition + animation across the document while we flip
    // the density class, so anything with a transitioned height/padding swaps
    // atomically rather than animating between the old and new metrics. Mirrors
    // the same atomic-swap guard `ThemeToggle` uses for the palette flip.
    const disable = document.createElement("style");
    disable.appendChild(
      document.createTextNode(
        "*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}",
      ),
    );
    document.head.appendChild(disable);

    applyDensity(next);

    // Force a reflow so the disable rule + class change land in the same paint.
    void window.getComputedStyle(document.body).backgroundColor;

    window.requestAnimationFrame(() => {
      document.head.removeChild(disable);
    });

    persistDensity(next);
    setIsCompact(next);
  };

  // Render a neutral placeholder before hydration finishes so the swapped icon
  // doesn't pop in. Using the comfortable default is fine here because the user
  // can't interact with it yet.
  const showCompact = isCompact ?? false;
  const Icon = showCompact ? Maximize2 : Minimize2;
  const label = showCompact ? "Comfortable density" : "Compact density";

  if (variant === "icon-button") {
    return (
      <button
        aria-label={label}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={toggle}
        title={label}
        type="button"
      >
        <Icon className="size-3.5" />
      </button>
    );
  }

  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        "text-foreground hover:bg-accent",
      )}
      onClick={toggle}
      type="button"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span>{label}</span>
    </button>
  );
}
