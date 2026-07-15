export const REPLAY_TRACE_ARTIFACT_NAMES = ["trace", "trace.zip"] as const;

type ReplayTraceCandidate = {
  type: string;
  name: string;
};

export function isReplayTraceArtifact(artifact: ReplayTraceCandidate): boolean {
  return (
    artifact.type === "trace" &&
    REPLAY_TRACE_ARTIFACT_NAMES.some((name) => name === artifact.name)
  );
}

export function selectReplayTracesByAttempt<
  T extends ReplayTraceCandidate & { attempt: number },
>(rows: readonly T[]): T[] {
  const byAttempt = new Map<number, T>();
  for (const row of rows) {
    if (!isReplayTraceArtifact(row)) continue;
    const current = byAttempt.get(row.attempt);
    if (!current || (current.name === "trace.zip" && row.name === "trace")) {
      byAttempt.set(row.attempt, row);
    }
  }
  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
}
