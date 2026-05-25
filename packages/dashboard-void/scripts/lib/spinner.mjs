import pc from "picocolors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const isTTY = process.stdout.isTTY;

/**
 * Render an animated braille spinner after `prefix` on the current line.
 * Returns stop(), which clears the interval and leaves the cursor right
 * after `prefix` so the caller can write `done` / `failed` / etc.
 *
 * In non-TTY environments, writes `prefix` once and returns a no-op stop —
 * so CI logs stay linear.
 */
export function startSpinner(prefix) {
  if (!isTTY) {
    process.stdout.write(prefix);
    return () => {};
  }
  let frame = 0;
  const render = () => {
    process.stdout.write(`\r${prefix}${pc.cyan(FRAMES[frame])} `);
    frame = (frame + 1) % FRAMES.length;
  };
  render();
  const timer = setInterval(render, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write(`\r${prefix}`);
  };
}
