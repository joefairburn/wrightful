import { createHash } from "node:crypto";

export function computeTestId(
  file: string,
  titlePath: string[],
  projectName: string,
): string {
  const input = [file, ...titlePath, projectName].join("\0");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
