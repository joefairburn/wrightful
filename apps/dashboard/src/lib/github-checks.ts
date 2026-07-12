import { and, db, eq, isNull, lt, or } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { githubInstallations, projects, runs, teams } from "@schema";
import { githubAppEnabled } from "@/lib/config";
import { changedRows } from "@/lib/db-batch";
import { mintInstallationToken } from "@/lib/github-app";
import { githubFetch, parseRepoOwner } from "@/lib/github-http";

/**
 * TTL (seconds) for a `githubCheckClaimedAt` claim (see {@link claimCheckRunSlot}).
 * Must exceed the two sequential GitHub calls a POST makes (mint-token +
 * check-run, ~20s at `REQUEST_TIMEOUT_MS` = 10s each) so a claim never expires
 * mid-POST. 120s leaves wide margin.
 */
const CHECK_CLAIM_TTL_SECONDS = 120;

/**
 * Post a GitHub **check run** summarizing a completed run, so a PR's merge gate
 * reflects the test outcome. Dashboard-side (not reporter-side) because:
 *   - a check run needs an *installation* token (only a GitHub App mints one),
 *     which — unlike a CI `GITHUB_TOKEN` — works on fork PRs;
 *   - the dashboard owns the authoritative post-`completeRun` aggregates + the
 *     canonical run URL;
 *   - runs finalized by the watchdog/synthetic path never reach reporter
 *     `onEnd`, but still flow through `maybePostGithubCheck`.
 *
 * The reporter's `postPrComment` stays as the no-App fallback for self-hosters.
 */

export type CheckConclusion = "success" | "failure" | "neutral";

interface RunCheckSummary {
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  durationMs: number;
}

/**
 * Map a terminal run status to a check-run conclusion. PURE — the merge-gate
 * decision, unit-tested directly. `failed`/`timedout`/`interrupted` fail the
 * check (interrupted = incomplete, don't merge); `passed` succeeds even with
 * flaky retries (every test ultimately passed; the output notes the flake
 * count); anything unrecognized is `neutral` (non-blocking).
 */
export function statusToConclusion(status: string): CheckConclusion {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "timedout":
    case "interrupted":
      return "failure";
    default:
      return "neutral";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round to whole seconds before splitting, so a leftover rounding up to 60
  // carries into the minutes place instead of rendering as "1m 60s".
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds - minutes * 60}s`;
}

/** The check-run `output` (title + markdown summary). PURE. */
export function buildCheckRunOutput(
  summary: RunCheckSummary,
  detailsUrl: string,
): { title: string; summary: string } {
  const failed = summary.failed;
  const title =
    statusToConclusion(summary.status) === "success"
      ? `${summary.passed} passed${summary.flaky > 0 ? `, ${summary.flaky} flaky` : ""}`
      : `${failed} failed, ${summary.passed} passed`;
  const body = [
    `| Passed | Failed | Flaky | Skipped | Duration |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${summary.passed} | ${summary.failed} | ${summary.flaky} | ${summary.skipped} | ${formatDuration(summary.durationMs)} |`,
    "",
    `[View run report →](${detailsUrl})`,
  ].join("\n");
  return { title, summary: body };
}

/**
 * Build the `/repos/:owner/:repo/check-runs[/:id]` path, percent-encoding each
 * `repo` segment. `repo` is attacker-controlled ingest input (`run.repo`), so
 * encoding stops reserved chars (`?`, `#`, `%`, …) from reinterpreting the
 * request — e.g. a `?` starting a query string and truncating the path before
 * `/check-runs`. PURE.
 */
export function buildCheckRunPath(
  repo: string,
  existingCheckRunId: number | null,
): string {
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  return existingCheckRunId
    ? `/repos/${encodedRepo}/check-runs/${existingCheckRunId}`
    : `/repos/${encodedRepo}/check-runs`;
}

/**
 * Atomically claim the "post a check run" slot for `runId` by writing
 * `nowSeconds` into `githubCheckClaimedAt`, but only if `githubCheckRunId` is
 * still null AND the claim column is null or holds an expired claim (left by a
 * poster that crashed before persisting a real id). Makes concurrent
 * `completeRun` + `finalizeStaleRun` race-safe: only one caller's `UPDATE`
 * matches, so only one POSTs; the loser sees `changedRows === 0` and backs off.
 *
 * `projectId` is ANDed in alongside `runs.id` per the `runByIdWhere` convention
 * (`@/lib/scope.ts`) but doesn't affect the race — `runs.id` is a unique ULID,
 * so the extra predicate only narrows to the same row or zero, never widens.
 *
 * Returns the claim token (`nowSeconds`), or null if the slot is already held.
 */
async function claimCheckRunSlot(
  runId: string,
  projectId: string,
  nowSeconds: number,
): Promise<number | null> {
  const result = await db
    .update(runs)
    .set({ githubCheckClaimedAt: nowSeconds })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.projectId, projectId),
        isNull(runs.githubCheckRunId),
        or(
          isNull(runs.githubCheckClaimedAt),
          lt(runs.githubCheckClaimedAt, nowSeconds - CHECK_CLAIM_TTL_SECONDS),
        ),
      ),
    );
  return changedRows(result) === 1 ? nowSeconds : null;
}

/** POST a new check run, or PATCH the existing one. Returns its id. */
async function postCheckRun(
  token: string,
  repo: string,
  headSha: string,
  conclusion: CheckConclusion,
  detailsUrl: string,
  output: { title: string; summary: string },
  existingCheckRunId: number | null,
): Promise<number | null> {
  const body = {
    name: "Wrightful",
    head_sha: headSha,
    status: "completed",
    conclusion,
    details_url: detailsUrl,
    output,
  };
  const path = buildCheckRunPath(repo, existingCheckRunId);
  const response = await githubFetch(
    path,
    {
      method: existingCheckRunId ? "PATCH" : "POST",
      body: JSON.stringify(body),
    },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub check-run ${existingCheckRunId ? "PATCH" : "POST"} failed: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as { id?: number };
  return json.id ?? null;
}

/**
 * Best-effort: post/update the GitHub check run for a completed run. Reads
 * everything it needs by `runId` (so both `completeRun` and `finalizeStaleRun`
 * call it the same way), and NEVER throws — a GitHub outage must not fail
 * ingest. No-ops cheaply (no DB read) when the App isn't configured, the run
 * has no repo/commit, or no installation OWNED BY THE RUN'S TEAM matches the
 * repo owner.
 *
 * The installation lookup is scoped to `run.teamId` (not the repo-owner string
 * alone) on purpose: `run.repo` is attacker-controlled ingest input, so a
 * by-owner-only lookup would be a cross-tenant confused deputy — any tenant
 * could name another org's repo and make us mint THAT org's installation token
 * to post a (merge-gating) check run on their repositories. Requiring the
 * installation to belong to the run's own team means a team can only post checks
 * for an org IT has connected.
 *
 * `projectId` comes from the caller's already-held run row and is ANDed into
 * every `runs` predicate below, per the `runByIdWhere` convention.
 */
export async function maybePostGithubCheck(
  runId: string,
  projectId: string,
): Promise<void> {
  if (!githubAppEnabled(env)) return;
  try {
    const rows = await db
      .select({
        teamId: runs.teamId,
        repo: runs.repo,
        commitSha: runs.commitSha,
        teamSlug: teams.slug,
        projectSlug: projects.slug,
        status: runs.status,
        passed: runs.passed,
        failed: runs.failed,
        flaky: runs.flaky,
        skipped: runs.skipped,
        totalTests: runs.totalTests,
        durationMs: runs.durationMs,
        githubCheckRunId: runs.githubCheckRunId,
      })
      .from(runs)
      .innerJoin(teams, eq(teams.id, runs.teamId))
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
      .limit(1);
    const run = rows[0];
    if (!run?.repo || !run.commitSha) return;

    const owner = parseRepoOwner(run.repo);
    if (!owner) return;

    const installRows = await db
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      // Scope to the run's own team: a run may only drive the installation its
      // team connected, never one resolved purely from the attacker-supplied
      // `repo` owner. (accountLogin is globally unique, so this is still a point
      // seek; the team predicate is the authorization boundary.)
      .where(
        and(
          eq(githubInstallations.teamId, run.teamId),
          eq(githubInstallations.accountLogin, owner),
        ),
      )
      .limit(1);
    const installationId = installRows[0]?.installationId;
    if (!installationId) return;

    // Claim-before-POST: only claim when we don't already have a real id.
    // `claim` is set iff we hold the slot (so must CAS-guard our writes below);
    // a direct PATCH of an already-known id never claims.
    let existingId = run.githubCheckRunId;
    let claim: number | null = null;

    if (existingId === null) {
      claim = await claimCheckRunSlot(
        runId,
        projectId,
        Math.floor(Date.now() / 1000),
      );
      if (claim === null) {
        // Lost the claim race — another caller is posting. Re-read once: if
        // their real id has landed, PATCH it; otherwise their in-flight POST
        // covers this completion, so skip (no check run is silently dropped).
        const reread = await db
          .select({ githubCheckRunId: runs.githubCheckRunId })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
          .limit(1);
        existingId = reread[0]?.githubCheckRunId ?? null;
        if (existingId === null) return;
      }
    }

    const token = await mintInstallationToken(installationId);

    const detailsUrl = `${env.WRIGHTFUL_PUBLIC_URL}/t/${run.teamSlug}/p/${run.projectSlug}/runs/${runId}`;
    let checkRunId: number | null;
    try {
      checkRunId = await postCheckRun(
        token,
        run.repo,
        run.commitSha,
        statusToConclusion(run.status),
        detailsUrl,
        buildCheckRunOutput(run, detailsUrl),
        existingId,
      );
    } catch (err) {
      if (claim !== null) {
        // Release our claim (only if it's still ours) so a POST failure
        // doesn't block a retry/watchdog for the full TTL.
        await db
          .update(runs)
          .set({ githubCheckClaimedAt: null })
          .where(
            and(
              eq(runs.id, runId),
              eq(runs.projectId, projectId),
              eq(runs.githubCheckClaimedAt, claim),
            ),
          )
          .catch((releaseErr: unknown) => {
            logger.warn("github check-run claim release failed", {
              runId,
              message:
                releaseErr instanceof Error
                  ? releaseErr.message
                  : String(releaseErr),
            });
          });
      }
      throw err;
    }

    // Persist the id so a re-complete PATCHes instead of POSTing a duplicate.
    if (checkRunId && checkRunId !== existingId) {
      await db
        .update(runs)
        .set({ githubCheckRunId: checkRunId, githubCheckClaimedAt: null })
        .where(
          claim !== null
            ? // CAS on our own claim token: if a reclaimed slow winner's slot
              // has since been superseded by a newer id, don't clobber it.
              and(
                eq(runs.id, runId),
                eq(runs.projectId, projectId),
                eq(runs.githubCheckClaimedAt, claim),
              )
            : and(eq(runs.id, runId), eq(runs.projectId, projectId)),
        );
    }
  } catch (err) {
    logger.error("github check-run post failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
