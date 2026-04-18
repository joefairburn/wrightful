export function prUrl(
  ciProvider: string | null,
  repo: string | null,
  prNumber: number | null,
): string | null {
  if (!repo || prNumber == null) return null;
  if (ciProvider === "github-actions") {
    return `https://github.com/${repo}/pull/${prNumber}`;
  }
  if (ciProvider === "gitlab-ci") {
    return `https://gitlab.com/${repo}/-/merge_requests/${prNumber}`;
  }
  return null;
}
