import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "mock commit message\n"),
}));

import { execFileSync } from "node:child_process";
import { detectCI, readGitCommitMessage } from "../lib/ci-detect.js";

const mockedExec = vi.mocked(execFileSync);

describe("detectCI", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockedExec.mockReset();
    mockedExec.mockReturnValue("mock commit message\n");
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
      vi.stubEnv("GITHUB_ACTOR", "octocat");
      vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "");

      const ci = detectCI();
      expect(ci).toEqual({
        ciProvider: "github-actions",
        ciBuildId: "12345",
        branch: "main",
        commitSha: "abc123",
        commitMessage: "mock commit message",
        prNumber: null,
        repo: "org/repo",
        actor: "octocat",
      });
    });

    it("prefers GITHUB_TRIGGERING_ACTOR over GITHUB_ACTOR", () => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("GITHUB_ACTOR", "original-pusher");
      vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "rerunner");
      expect(detectCI()?.actor).toBe("rerunner");
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

    it("returns null commitMessage when git fails", () => {
      vi.stubEnv("GITHUB_ACTIONS", "true");
      mockedExec.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      expect(detectCI()?.commitMessage).toBeNull();
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
      vi.stubEnv("GITLAB_USER_LOGIN", "alice");

      const ci = detectCI();
      expect(ci?.ciProvider).toBe("gitlab-ci");
      expect(ci?.ciBuildId).toBe("999");
      expect(ci?.branch).toBe("develop");
      expect(ci?.commitMessage).toBe("fix stuff");
      expect(ci?.actor).toBe("alice");
    });

    it("falls back to git when CI_COMMIT_MESSAGE is missing", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "true");
      vi.stubEnv("CI_COMMIT_MESSAGE", "");
      expect(detectCI()?.commitMessage).toBe("mock commit message");
    });

    it("extracts merge request IID as prNumber", () => {
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("GITLAB_CI", "true");
      vi.stubEnv("CI_PIPELINE_ID", "999");
      vi.stubEnv("CI_MERGE_REQUEST_IID", "15");
      vi.stubEnv("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", "feat");
      vi.stubEnv("CI_COMMIT_BRANCH", "");
      vi.stubEnv("CI_COMMIT_SHA", "abc");
      vi.stubEnv("CI_COMMIT_MESSAGE", "msg");
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
      vi.stubEnv("CIRCLE_USERNAME", "bob");

      const ci = detectCI();
      expect(ci?.ciProvider).toBe("circleci");
      expect(ci?.repo).toBe("org/repo");
      expect(ci?.actor).toBe("bob");
      expect(ci?.commitMessage).toBe("mock commit message");
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
      expect(ci?.actor).toBeNull();
    });
  });
});

describe("readGitCommitMessage", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("returns trimmed commit message on success", () => {
    mockedExec.mockReturnValue("first line\nsecond line\n\n");
    expect(readGitCommitMessage()).toBe("first line\nsecond line");
  });

  it("returns null when git throws", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("git not found");
    });
    expect(readGitCommitMessage()).toBeNull();
  });

  it("returns null for empty output", () => {
    mockedExec.mockReturnValue("");
    expect(readGitCommitMessage()).toBeNull();
  });
});
