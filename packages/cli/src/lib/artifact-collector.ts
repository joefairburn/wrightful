import type { PlaywrightReport } from "../types.js";

export interface ArtifactManifest {
  artifacts: Array<{
    testResultId: string;
    type: "trace" | "screenshot" | "video" | "other";
    name: string;
    contentType: string;
    localPath: string;
    sizeBytes: number;
  }>;
}

export function collectArtifacts(
  _report: PlaywrightReport,
  _mode: "all" | "failed" | "none",
): ArtifactManifest {
  // Phase 1: no-op — artifact upload implemented in Phase 2
  return { artifacts: [] };
}
