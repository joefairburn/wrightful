import { createHash } from "node:crypto";

// Stable per-test identifier derived from file + title path + project name.
// The dashboard groups rows with the same testId into test history, so the
// hash must be deterministic across runs.
export function computeTestId(
  file: string,
  titlePath: string[],
  projectName: string,
): string {
  const input = [file, ...titlePath, projectName].join("\0");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
