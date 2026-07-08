import { describe, expect, it } from "vitest";
import { cn } from "@/lib/cn";

describe("cn", () => {
  // Regression: tailwind-merge classifies the app's whole-pixel font-size
  // tokens (`text-12`, …) as a *color* out of the box, so it drops them when
  // they collide with an actual text color. `cn` registers the ramp with the
  // font-size group so a size and a color survive together.
  it("keeps a numeric font-size token alongside a text color", () => {
    expect(cn("text-12 text-fg-1")).toBe("text-12 text-fg-1");
    expect(cn("text-11 text-fg-4")).toBe("text-11 text-fg-4");
    expect(cn("text-14 text-fg-2")).toBe("text-14 text-fg-2");
  });

  it("still collapses conflicting font sizes to the last one", () => {
    expect(cn("text-12 text-13")).toBe("text-13");
    expect(cn("text-sm text-12")).toBe("text-12");
  });

  it("still collapses conflicting text colors to the last one", () => {
    expect(cn("text-fg-1 text-fg-2")).toBe("text-fg-2");
  });
});
