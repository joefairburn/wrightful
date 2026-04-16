import { describe, it, expect, beforeEach, vi } from "vitest";
import { detectCI } from "../lib/ci-detect.js";

describe("detectCI", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when not in CI", () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("CIRCLECI", "");
    expect(detectCI()).toBeNull();
  });

  describe("GitHub Actions", () => {
    it("detects GitHub Actions", () => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("GITHUB_RUN_ID", "12345");
      vi.stubEnv("GITHUB_REF_NAME", "main");
      vi.stubEnv("GITHUB_SHA", "abc123");
      vi.stubEnv("GITHUB_REPOSITORY", "org/repo");
      vi.stubEnv("GITHUB_HEAD_REF", "");
      vi.stubEnv("GITHUB_REF", "refs/heads/main");

      const ci = detectCI();
      expect(ci).toEqual({
        ciProvider: "github-actions",
        ciBuildId: "12345",
        branch: "main",
        commitSha: "abc123",
        commitMessage: null,
        prNumber: null,
        repo: "org/repo",
      });
    });

    it("extracts PR number from GITHUB_REF", () => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("GITHUB_RUN_ID", "12345");
      vi.stubEnv("GITHUB_REF", "refs/pull/42/merge");
      vi.stubEnv("GITHUB_HEAD_REF", "feature-branch");
      vi.stubEnv("GITHUB_REF_NAME", "42/merge");
      vi.stubEnv("GITHUB_SHA", "abc123");
      vi.stubEnv("GITHUB_REPOSITORY", "org/repo");

      const ci = detectCI();
      expect(ci?.prNumber).toBe(42);
      expect(ci?.branch).toBe("feature-branch");
    });

    it("prefers GITHUB_HEAD_REF over GITHUB_REF_NAME for branch", () => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("GITHUB_HEAD_REF", "feature");
      vi.stubEnv("GITHUB_REF_NAME", "42/merge");
      vi.stubEnv("GITHUB_RUN_ID", "1");
      vi.stubEnv("GITHUB_SHA", "abc");
      vi.stubEnv("GITHUB_REPOSITORY", "o/r");
      vi.stubEnv("GITHUB_REF", "");

      expect(detectCI()?.branch).toBe("feature");
    });
  });

  describe("GitLab CI", () => {
    it("detects GitLab CI", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "true");
      vi.stubEnv("CI_PIPELINE_ID", "999");
      vi.stubEnv("CI_COMMIT_BRANCH", "develop");
      vi.stubEnv("CI_COMMIT_SHA", "def456");
      vi.stubEnv("CI_COMMIT_MESSAGE", "fix stuff");
      vi.stubEnv("CI_PROJECT_PATH", "group/project");
      vi.stubEnv("CI_MERGE_REQUEST_IID", "");
      vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", "");

      const ci = detectCI();
      expect(ci?.ciProvider).toBe("gitlab-ci");
      expect(ci?.ciBuildId).toBe("999");
      expect(ci?.branch).toBe("develop");
      expect(ci?.commitMessage).toBe("fix stuff");
    });

    it("extracts merge request IID as prNumber", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "true");
      vi.stubEnv("CI_PIPELINE_ID", "999");
      vi.stubEnv("CI_MERGE_REQUEST_IID", "15");
      vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", "feat");
      vi.stubEnv("CI_COMMIT_BRANCH", "");
      vi.stubEnv("CI_COMMIT_SHA", "abc");
      vi.stubEnv("CI_COMMIT_MESSAGE", "");
      vi.stubEnv("CI_PROJECT_PATH", "g/p");

      const ci = detectCI();
      expect(ci?.prNumber).toBe(15);
      expect(ci?.branch).toBe("feat");
    });
  });

  describe("CircleCI", () => {
    it("detects CircleCI", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "");
      vi.stubEnv("CIRCLECI", "true");
      vi.stubEnv("CIRCLE_WORKFLOW_ID", "wf-1");
      vi.stubEnv("CIRCLE_BRANCH", "main");
      vi.stubEnv("CIRCLE_SHA1", "sha1");
      vi.stubEnv("CIRCLE_PROJECT_USERNAME", "org");
      vi.stubEnv("CIRCLE_PROJECT_REPONAME", "repo");
      vi.stubEnv("CIRCLE_PR_NUMBER", "");
      vi.stubEnv("CIRCLE_PULL_REQUEST", "");

      const ci = detectCI();
      expect(ci?.ciProvider).toBe("circleci");
      expect(ci?.repo).toBe("org/repo");
    });

    it("extracts PR number from CIRCLE_PULL_REQUEST URL", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "");
      vi.stubEnv("CIRCLECI", "true");
      vi.stubEnv("CIRCLE_WORKFLOW_ID", "wf-1");
      vi.stubEnv("CIRCLE_BRANCH", "feat");
      vi.stubEnv("CIRCLE_SHA1", "sha1");
      vi.stubEnv("CIRCLE_PROJECT_USERNAME", "org");
      vi.stubEnv("CIRCLE_PROJECT_REPONAME", "repo");
      vi.stubEnv("CIRCLE_PR_NUMBER", "");
      vi.stubEnv("CIRCLE_PULL_REQUEST", "https://github.com/org/repo/pull/77");

      expect(detectCI()?.prNumber).toBe(77);
    });
  });

  describe("Generic CI", () => {
    it("detects generic CI=true", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "");
      vi.stubEnv("CIRCLECI", "");
      vi.stubEnv("CI", "true");

      const ci = detectCI();
      expect(ci?.ciProvider).toBe("unknown");
      expect(ci?.ciBuildId).toBeNull();
    });
  });
});
