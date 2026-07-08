import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The app's type ramp uses whole-pixel font-size tokens (`text-12`, `text-13`,
// … — see the `@theme` block in `styles.css`). tailwind-merge doesn't know
// these are font sizes, so out of the box it classifies e.g. `text-12` as a
// text *color* and drops it when it collides with a real color like
// `text-fg-1` (`twMerge("text-12 text-fg-1") === "text-fg-1"`) — silently
// leaving the element at the inherited default size. Registering the ramp with
// the `font-size` group fixes the classification so a size and a color survive
// together while size-vs-size still collapses to the last one.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-11",
        "text-12",
        "text-13",
        "text-14",
        "text-18",
        "text-22",
        "text-26",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
