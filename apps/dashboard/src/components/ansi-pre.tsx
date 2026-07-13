import type React from "react";
import { ansiToHtml } from "@/lib/ansi";
import { cn } from "@/lib/cn";

/**
 * ANSI-coloured monospace block. Owns the one justified
 * `dangerouslySetInnerHTML` for ANSI output — `ansiToHtml` HTML-escapes its
 * input before colourising, so the markup is safe by construction and the
 * lint suppression only has to exist here.
 */
export function AnsiPre({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.ReactElement {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: ansiToHtml HTML-escapes before colourising
    <pre
      className={cn("whitespace-pre-wrap break-words font-mono", className)}
      dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
    />
  );
}
