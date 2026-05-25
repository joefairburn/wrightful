import Anser from "anser";

// Playwright emits error messages with ANSI SGR escapes (e.g. `\x1b[31m`) for
// terminal colouring. Browsers drop the ESC but leave the `[31m` residue as
// literal text, which is what we were rendering before. `escapeForHtml` does
// the minimal `& < >` escaping up front; `ansiToHtml` with `use_classes`
// emits classes (see `.ansi-*` rules in `app/styles.css`) instead of inline
// styles so the palette picks up our theme.
export function ansiToHtml(text: string): string {
  return Anser.ansiToHtml(Anser.escapeForHtml(text), { use_classes: true });
}
