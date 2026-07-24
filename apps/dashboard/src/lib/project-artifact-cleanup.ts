import type { Context } from "hono";
import { and, asc, db, eq, lte, sql } from "void/db";
import { logger } from "void/log";
import { projectArtifactCleanupJobs } from "@schema";
import { ARTIFACT_PRESIGNED_PUT_TTL_SECONDS } from "@/lib/artifacts/constants";
import { deleteProjectArtifactObjects } from "@/lib/artifacts/store";

const ATTEMPT_PAGE_LIMIT = 100;
const CLAIM_LEASE_SECONDS = 10 * 60;
const INCOMPLETE_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 6 * 60 * 60;
const DIRECT_UPLOAD_EXPIRY_GRACE_SECONDS = 60;
// Four worst-case attempts consume at most 800 R2 list/delete subrequests,
// leaving margin below the Workers limit for the claim/result DB operations.
const SWEEP_JOB_LIMIT = 4;
const MAX_ERROR_LENGTH = 2_000;
// A team may own hundreds of projects. Starting one full R2 page per project
// in the delete request can exhaust the Worker subrequest budget even though
// every job is durable. One eager pass provides prompt cleanup without a fanout;
// the cron sees every untouched job as immediately due.
export const EAGER_TEAM_CLEANUP_LIMIT = 1;

export interface ProjectArtifactCleanupJobValues {
  projectId: string;
  teamId: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Build the outbox row inserted in the same transaction as project deletion. */
export function projectArtifactCleanupJobValues(
  teamId: string,
  projectId: string,
  nowSeconds: number,
): ProjectArtifactCleanupJobValues {
  return {
    projectId,
    teamId,
    attempts: 0,
    nextAttemptAt: nowSeconds,
    lastError: null,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
  };
}

export type ProjectArtifactCleanupResult =
  | { kind: "notDue" }
  | { kind: "superseded"; deleted: number }
  | { kind: "complete"; deleted: number }
  | { kind: "incomplete"; deleted: number }
  | { kind: "failed"; message: string };

function retryDelaySeconds(attempts: number): number {
  return Math.min(
    MAX_RETRY_SECONDS,
    60 * 2 ** Math.min(Math.max(attempts - 1, 0), 8),
  );
}

/**
 * Claim and run one bounded cleanup pass.
 *
 * Claiming advances `nextAttemptAt` as a lease, so the response's eager
 * `waitUntil` pass and the retry cron cannot work the same prefix concurrently.
 * If the Worker stops mid-pass, the durable row becomes eligible again after
 * ten minutes. Every pass lists from the prefix head, so it needs no cursor and
 * safely resumes after partial deletion.
 */
export async function processProjectArtifactCleanup(
  projectId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ProjectArtifactCleanupResult> {
  const leaseUntil = nowSeconds + CLAIM_LEASE_SECONDS;
  const claimed = await db
    .update(projectArtifactCleanupJobs)
    .set({
      attempts: sql`${projectArtifactCleanupJobs.attempts} + 1`,
      nextAttemptAt: leaseUntil,
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(projectArtifactCleanupJobs.projectId, projectId),
        lte(projectArtifactCleanupJobs.nextAttemptAt, nowSeconds),
      ),
    )
    .returning();
  const job = claimed[0];
  if (!job) return { kind: "notDue" };
  // `attempts` increments on every claim and is therefore this pass's fencing
  // token. Once the lease expires, a successor increments it again; every
  // mutation below must include this predicate so the expired worker cannot
  // overwrite or delete its successor's state.
  const stillClaimed = and(
    eq(projectArtifactCleanupJobs.projectId, projectId),
    eq(projectArtifactCleanupJobs.attempts, job.attempts),
  );

  try {
    const result = await deleteProjectArtifactObjects(
      job.teamId,
      job.projectId,
      ATTEMPT_PAGE_LIMIT,
    );
    const finishedAt = Math.max(nowSeconds, Math.floor(Date.now() / 1000));

    if (!result.complete) {
      const updated = await db
        .update(projectArtifactCleanupJobs)
        .set({
          nextAttemptAt: finishedAt + INCOMPLETE_RETRY_SECONDS,
          lastError: null,
          updatedAt: finishedAt,
        })
        .where(stillClaimed)
        .returning({ projectId: projectArtifactCleanupJobs.projectId });
      if (updated.length === 0) {
        return { kind: "superseded", deleted: result.deleted };
      }
      return { kind: "incomplete", deleted: result.deleted };
    }

    // A direct-R2 PUT minted immediately before deletion remains valid for up
    // to 15 minutes. Keep the job through that window and verify the prefix one
    // final time, otherwise a late upload could recreate an undiscoverable
    // orphan immediately after an apparently successful sweep.
    const finalizableAt =
      job.createdAt +
      ARTIFACT_PRESIGNED_PUT_TTL_SECONDS +
      DIRECT_UPLOAD_EXPIRY_GRACE_SECONDS;
    if (finishedAt < finalizableAt) {
      const updated = await db
        .update(projectArtifactCleanupJobs)
        .set({
          nextAttemptAt: finalizableAt,
          lastError: null,
          updatedAt: finishedAt,
        })
        .where(stillClaimed)
        .returning({ projectId: projectArtifactCleanupJobs.projectId });
      if (updated.length === 0) {
        return { kind: "superseded", deleted: result.deleted };
      }
      return { kind: "incomplete", deleted: result.deleted };
    }

    const deleted = await db
      .delete(projectArtifactCleanupJobs)
      .where(stillClaimed)
      .returning({ projectId: projectArtifactCleanupJobs.projectId });
    if (deleted.length === 0) {
      return { kind: "superseded", deleted: result.deleted };
    }
    return { kind: "complete", deleted: result.deleted };
  } catch (err) {
    const finishedAt = Math.max(nowSeconds, Math.floor(Date.now() / 1000));
    const message = (err instanceof Error ? err.message : String(err)).slice(
      0,
      MAX_ERROR_LENGTH,
    );
    const updated = await db
      .update(projectArtifactCleanupJobs)
      .set({
        nextAttemptAt: finishedAt + retryDelaySeconds(job.attempts),
        lastError: message,
        updatedAt: finishedAt,
      })
      .where(stillClaimed)
      .returning({ projectId: projectArtifactCleanupJobs.projectId });
    if (updated.length === 0) {
      return { kind: "superseded", deleted: 0 };
    }
    logger.warn("project artifact cleanup attempt failed", {
      projectId,
      attempts: job.attempts,
      message,
    });
    return { kind: "failed", message };
  }
}

/**
 * Start cleanup promptly after a committed delete. The durable outbox row, not
 * this `waitUntil`, is the reliability boundary; the cron retries any failed,
 * interrupted, or page-budget-limited pass.
 */
export function scheduleProjectArtifactCleanup(
  c: Context,
  projectId: string,
): void {
  c.executionCtx.waitUntil(
    processProjectArtifactCleanup(projectId)
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.error("project artifact cleanup dispatch failed", {
          projectId,
          message: err instanceof Error ? err.message : String(err),
        });
      }),
  );
}

/**
 * Kick off a bounded sample after whole-team deletion. Remaining project jobs
 * stay immediately due in the outbox and are drained by the canonical cron
 * sweep; they are intentionally not leased merely for being deferred.
 */
export function scheduleTeamArtifactCleanup(
  c: Context,
  projectIds: readonly string[],
): void {
  for (const projectId of projectIds.slice(0, EAGER_TEAM_CLEANUP_LIMIT)) {
    scheduleProjectArtifactCleanup(c, projectId);
  }
}

export interface ProjectArtifactCleanupSweepResult {
  claimed: number;
  superseded: number;
  completed: number;
  incomplete: number;
  failed: number;
  deleted: number;
}

/** Drain a bounded set of due outbox jobs; repeated cron ticks clear backlog. */
export async function sweepProjectArtifactCleanup(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ProjectArtifactCleanupSweepResult> {
  const due = await db
    .select({ projectId: projectArtifactCleanupJobs.projectId })
    .from(projectArtifactCleanupJobs)
    .where(lte(projectArtifactCleanupJobs.nextAttemptAt, nowSeconds))
    .orderBy(asc(projectArtifactCleanupJobs.createdAt))
    .limit(SWEEP_JOB_LIMIT);
  const tally: ProjectArtifactCleanupSweepResult = {
    claimed: 0,
    superseded: 0,
    completed: 0,
    incomplete: 0,
    failed: 0,
    deleted: 0,
  };

  for (const row of due) {
    const result = await processProjectArtifactCleanup(
      row.projectId,
      nowSeconds,
    );
    if (result.kind === "notDue") continue;
    tally.claimed++;
    if (result.kind === "superseded") {
      tally.superseded++;
      tally.deleted += result.deleted;
      continue;
    }
    if (result.kind === "failed") {
      tally.failed++;
      continue;
    }
    tally.deleted += result.deleted;
    if (result.kind === "complete") tally.completed++;
    else tally.incomplete++;
  }

  return tally;
}
