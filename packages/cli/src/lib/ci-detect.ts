import { execFileSync } from "node:child_process";
import type { CIInfo } from "../types.js";

function extractGitHubPrNumber(): number | null {
  const ref = process.env.GITHUB_REF;
  if (!ref) return null;
  const match = ref.match(/^refs\/pull\/(\d+)\/merge$/);
  return match ? parseInt(match[1], 10) : null;
}

function extractCirclePrNumber(): number | null {
  const prNum = process.env.CIRCLE_PR_NUMBER;
  if (prNum) return parseInt(prNum, 10);

  const prUrl = process.env.CIRCLE_PULL_REQUEST;
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

export function readGitCommitMessage(): string | null {
  try {
    const msg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return msg || null;
  } catch {
    return null;
  }
}

export function detectCI(): CIInfo | null {
  // GitHub Actions
  if (process.env.GITHUB_ACTIONS === "true") {
    return {
      ciProvider: "github-actions",
      ciBuildId: process.env.GITHUB_RUN_ID ?? null,
      branch:
        process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
      commitSha: process.env.GITHUB_SHA ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: extractGitHubPrNumber(),
      repo: process.env.GITHUB_REPOSITORY ?? null,
      actor:
        process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || null,
    };
  }

  // GitLab CI
  if (process.env.GITLAB_CI === "true") {
    return {
      ciProvider: "gitlab-ci",
      ciBuildId: process.env.CI_PIPELINE_ID ?? null,
      branch:
        process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ||
        process.env.CI_COMMIT_BRANCH ||
        null,
      commitSha: process.env.CI_COMMIT_SHA ?? null,
      commitMessage: process.env.CI_COMMIT_MESSAGE || readGitCommitMessage(),
      prNumber: process.env.CI_MERGE_REQUEST_IID
        ? parseInt(process.env.CI_MERGE_REQUEST_IID, 10)
        : null,
      repo: process.env.CI_PROJECT_PATH ?? null,
      actor: process.env.GITLAB_USER_LOGIN ?? null,
    };
  }

  // CircleCI
  if (process.env.CIRCLECI === "true") {
    return {
      ciProvider: "circleci",
      ciBuildId: process.env.CIRCLE_WORKFLOW_ID ?? null,
      branch: process.env.CIRCLE_BRANCH ?? null,
      commitSha: process.env.CIRCLE_SHA1 ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: extractCirclePrNumber(),
      repo:
        process.env.CIRCLE_PROJECT_USERNAME &&
        process.env.CIRCLE_PROJECT_REPONAME
          ? `${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}`
          : null,
      actor: process.env.CIRCLE_USERNAME ?? null,
    };
  }

  // Generic CI detection
  if (process.env.CI === "true") {
    return {
      ciProvider: "unknown",
      ciBuildId: null,
      branch: null,
      commitSha: null,
      commitMessage: readGitCommitMessage(),
      prNumber: null,
      repo: null,
      actor: null,
    };
  }

  return null;
}
