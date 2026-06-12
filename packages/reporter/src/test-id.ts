import { createHash } from "node:crypto";

// Stable per-test identifier derived from file + title path + project name
// (+ repeat-each index). The dashboard groups rows with the same testId into
// test history, so the hash must be deterministic across runs.
export function computeTestId(
  file: string,
  titlePath: string[],
  projectName: string,
  repeatEachIndex = 0,
): string {
  const parts = [file, ...titlePath, projectName];
  // `--repeat-each` repeats share file/title/project; without this they'd
  // collapse into one testId/clientKey and overwrite each other. Only folded
  // in when > 0 so every pre-existing id stays stable.
  if (repeatEachIndex > 0) parts.push(`repeat-${repeatEachIndex}`);
  const input = parts.join("\0");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
