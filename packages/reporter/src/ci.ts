import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// CI environment detection. Reads standard env vars on GitHub Actions,
// GitLab CI, and CircleCI; falls back to a `CI=true` generic case. Commit
// message is read via `git log` because no CI env exposes it consistently.

export interface CIInfo {
  ciProvider: string | null;
  ciBuildId: string | null;
  /**
   * Job-level discriminator within a build (GITHUB_JOB / CI_JOB_NAME). The
   * build id alone is workflow/pipeline-scoped, so without this matrix and
   * parallel jobs would share an idempotency key and merge into one run.
   */
  ciJobName: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  repo: string | null;
  actor: string | null;
}

function readGitCommitMessage(): string | null {
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

function githubPrNumber(): number | null {
  const ref = process.env.GITHUB_REF;
  const match = ref?.match(/^refs\/pull\/(\d+)\/merge$/);
  if (match) return parseInt(match[1], 10);
  // `pull_request_target` / `merge_group` events don't get a refs/pull/N/merge
  // ref; fall back to the event payload GitHub writes to disk.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { number?: number };
    };
    const number = event.pull_request?.number;
    return typeof number === "number" ? number : null;
  } catch {
    return null;
  }
}

function circlePrNumber(): number | null {
  const num = process.env.CIRCLE_PR_NUMBER;
  if (num) return parseInt(num, 10);
  const url = process.env.CIRCLE_PULL_REQUEST;
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

export function detectCI(): CIInfo | null {
  if (process.env.GITHUB_ACTIONS === "true") {
    return {
      ciProvider: "github-actions",
      ciBuildId: process.env.GITHUB_RUN_ID ?? null,
      ciJobName: process.env.GITHUB_JOB ?? null,
      branch:
        process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
      commitSha: process.env.GITHUB_SHA ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: githubPrNumber(),
      repo: process.env.GITHUB_REPOSITORY ?? null,
      actor:
        process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || null,
    };
  }
  if (process.env.GITLAB_CI === "true") {
    return {
      ciProvider: "gitlab-ci",
      ciBuildId: process.env.CI_PIPELINE_ID ?? null,
      ciJobName: process.env.CI_JOB_NAME ?? null,
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
  if (process.env.CIRCLECI === "true") {
    return {
      ciProvider: "circleci",
      ciBuildId: process.env.CIRCLE_WORKFLOW_ID ?? null,
      ciJobName: process.env.CIRCLE_JOB ?? null,
      branch: process.env.CIRCLE_BRANCH ?? null,
      commitSha: process.env.CIRCLE_SHA1 ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: circlePrNumber(),
      repo:
        process.env.CIRCLE_PROJECT_USERNAME &&
        process.env.CIRCLE_PROJECT_REPONAME
          ? `${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}`
          : null,
      actor: process.env.CIRCLE_USERNAME ?? null,
    };
  }
  if (process.env.CI === "true") {
    return {
      ciProvider: "unknown",
      ciBuildId: null,
      ciJobName: null,
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

export interface IdempotencyDiscriminators {
  /** CI job name (e.g. GITHUB_JOB / CI_JOB_NAME). */
  jobName?: string | null;
}

// Mirror of the dashboard's `idempotencyKey` cap (MAX.ID in
// apps/dashboard/src/lib/schemas.ts) — a longer key would 400 the open call.
// Exported so `contract.test.ts` can pin it === the dashboard's MAX.ID.
export const MAX_IDEMPOTENCY_KEY_LENGTH = 1024;

/**
 * Resolve the run's idempotency key. Precedence:
 *   1. `WRIGHTFUL_IDEMPOTENCY_KEY` env override — set by the synthetic-monitor
 *      container to the pre-known `monitorExecutions.id`, so the opened run is
 *      addressable by `(projectId, idempotencyKey === execution.id)` and the
 *      executor can resolve `runId` back from the execution without a handshake.
 *      Used verbatim — never decorated with discriminators.
 *   2. The CI build id (deterministic across re-runs of the same CI job, which
 *      is what lets a re-run recover the same run row), suffixed with the job
 *      name when present. The build id alone is workflow/pipeline-scoped, so
 *      distinct jobs (different suites in one workflow, matrix legs) would
 *      otherwise silently merge into one dashboard run. The job name is stable
 *      across re-runs, so re-run determinism survives the suffix.
 *
 *      Playwright `--shard` is deliberately NOT a discriminator: shards run
 *      slices of ONE suite and must share an idempotency key so the dashboard
 *      merges them into a single run — openRun's duplicate path, the queue
 *      prefill, and completeRun's monotonic cross-shard status merge are all
 *      designed around shards sharing one key.
 *   3. A random UUID for purely local runs.
 */
export function generateIdempotencyKey(
  ciBuildId: string | null | undefined,
  discriminators: IdempotencyDiscriminators = {},
): string {
  const explicit = process.env.WRIGHTFUL_IDEMPOTENCY_KEY;
  if (explicit) return explicit;
  if (!ciBuildId) return randomUUID();
  const parts = [ciBuildId];
  if (discriminators.jobName) parts.push(discriminators.jobName);
  return parts.join("-").slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}
