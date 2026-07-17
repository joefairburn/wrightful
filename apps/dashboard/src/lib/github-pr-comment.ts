import { and, db, desc, eq, inArray, isNull, lt, lte, or } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { ulid } from "ulid";
import {
  githubInstallations,
  githubPrComments,
  projects,
  runs,
  teams,
  testResults,
} from "@schema";
import { githubAppEnabled } from "@/lib/config";
import { changedRows } from "@/lib/db-batch";
import { mintInstallationToken } from "@/lib/github-app";
import { formatDuration, statusToConclusion } from "@/lib/github-checks";
import { githubFetch, parseRepoOwner } from "@/lib/github-http";
import { computeRunDiff, verdictOf } from "@/lib/run-diff";
import type { DiffRunRef, RunDiff } from "@/lib/run-diff";
import { childByRunWhere, makeTenantScope, runScopeWhere } from "@/lib/scope";
import type { TenantScope } from "@/lib/scope";

/**
 * Sticky GitHub **PR comment** summarizing a completed run — the surface teams
 * actually read on a PR, complementing the merge-gating check run
 * (`@/lib/github-checks`, whose module doc explains why this lives dashboard-
 * side: installation tokens work on fork PRs, the dashboard owns the
 * authoritative aggregates, and watchdog-finalized runs never reach reporter
 * `onEnd`). Unlike the per-run check, the comment is keyed per **PR**: every
 * run on the PR upserts the SAME comment (tracked in `githubPrComments`), so a
 * PR accumulates one evolving summary instead of a stack of comments.
 *
 * Beyond the check's counters, the comment classifies failures new-vs-known
 * against the branch's natural baseline (`@/lib/run-diff`) and lists flaky
 * detections, each deep-linked to its test-result page.
 *
 * The reporter's `postPrComment` (CI-token, `packages/reporter/src/pr-comment.ts`)
 * stays as the no-App fallback for self-hosters; it uses a different marker, so
 * enabling both yields two comments — configure one or the other.
 */

/**
 * TTL (seconds) for a `githubPrComments.claimedAt` claim. Same contract as the
 * check-run claim (`CHECK_CLAIM_TTL_SECONDS` in `@/lib/github-checks`): must
 * outlive the mint-token + comment POST sequence so a claim never expires
 * mid-POST; 120s leaves wide margin over two 10s-timeout GitHub calls.
 */
const PR_COMMENT_CLAIM_TTL_SECONDS = 120;

/**
 * Cap per failure/flaky section. The comment is a summary, not the report —
 * overflow renders as "…and N more" with the full list one click away on the
 * linked run page.
 */
const MAX_LISTED_TESTS = 10;

/**
 * Hidden HTML marker identifying OUR sticky comment, scoped by projectId so two
 * Wrightful projects reporting into the same PR keep separate comments. The DB
 * row (not a marker scan) is what finds the comment to update — the marker
 * exists for human debugging and is deliberately distinct from the reporter
 * fallback's `<!-- wrightful:pr-comment -->` so the two never fight over one
 * comment with different bodies. PURE.
 */
export function prCommentMarker(projectId: string): string {
  return `<!-- wrightful:pr-summary:${projectId} -->`;
}

/** One listed test in a failure/flaky section. */
export interface PrCommentTestLine {
  title: string;
  file: string;
  /** `testResults.id` for the deep link, or null to render plain text. */
  testResultId: string | null;
}

/** Everything {@link buildPrCommentBody} needs — assembled by the orchestrator. */
export interface PrCommentContent {
  projectId: string;
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  /** Absolute canonical run URL (`…/runs/:runId`) — also the deep-link base. */
  runUrl: string;
  commitSha: string | null;
  /**
   * Whether a baseline run was resolvable. With a base, failures split into
   * new-vs-known (and a compare link renders); without one they collapse into a
   * single "Failures" section.
   */
  hasBase: boolean;
  baseCommitSha: string | null;
  /** Failing in head, passing/absent in base — or ALL failures when no base. */
  newFailures: PrCommentTestLine[];
  /** Failing in both head and base. Empty when no base. */
  knownFailures: PrCommentTestLine[];
  /** Passed only after retry in this run. */
  flakyTests: PrCommentTestLine[];
}

/**
 * Make a test title safe inside `[…](…)` link text: collapse newlines and
 * escape the markdown-active characters that would break out of the link
 * (titles are user-authored ingest input). PURE.
 */
function escapeMdLinkText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([\\[\]`])/g, "\\$1")
    .trim();
}

function testListLines(
  tests: readonly PrCommentTestLine[],
  runUrl: string,
): string[] {
  const lines = tests.slice(0, MAX_LISTED_TESTS).map((t) => {
    const label = escapeMdLinkText(t.title);
    const linked = t.testResultId
      ? `[${label}](${runUrl}/tests/${t.testResultId})`
      : label;
    return `- ${linked} — \`${t.file}\``;
  });
  if (tests.length > MAX_LISTED_TESTS) {
    lines.push(`- …and ${tests.length - MAX_LISTED_TESTS} more`);
  }
  return lines;
}

function sectionLines(
  heading: string,
  note: string,
  tests: readonly PrCommentTestLine[],
  runUrl: string,
): string[] {
  if (tests.length === 0) return [];
  return [
    "",
    `**${heading} (${tests.length})** — ${note}`,
    "",
    ...testListLines(tests, runUrl),
  ];
}

/** The full comment markdown. PURE — the unit-test surface for rendering. */
export function buildPrCommentBody(content: PrCommentContent): string {
  const conclusion = statusToConclusion(content.status);
  const emoji =
    conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⚪";
  // Same headline wording as the check-run title (`buildCheckRunOutput`) so the
  // two GitHub surfaces never disagree at a glance.
  const title =
    conclusion === "success"
      ? `${content.passed} passed${content.flaky > 0 ? `, ${content.flaky} flaky` : ""}`
      : `${content.failed} failed, ${content.passed} passed`;

  const lines = [
    prCommentMarker(content.projectId),
    `### ${emoji} Wrightful — ${title}`,
    "",
    `| Passed | Failed | Flaky | Skipped | Duration |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${content.passed} | ${content.failed} | ${content.flaky} | ${content.skipped} | ${formatDuration(content.durationMs)} |`,
    ...(content.hasBase
      ? [
          ...sectionLines(
            "New failures",
            "passing on the base run, failing here",
            content.newFailures,
            content.runUrl,
          ),
          ...sectionLines(
            "Still failing",
            "already failing on the base run",
            content.knownFailures,
            content.runUrl,
          ),
        ]
      : sectionLines(
          "Failures",
          "no baseline run to compare against",
          content.newFailures,
          content.runUrl,
        )),
    ...sectionLines(
      "Flaky",
      "passed only after retry",
      content.flakyTests,
      content.runUrl,
    ),
    "",
    `[View run report →](${content.runUrl})` +
      (content.hasBase ? ` · [Compare to base →](${content.runUrl}/diff)` : ""),
  ];
  if (content.commitSha) {
    const baseSuffix = content.baseCommitSha
      ? ` · Base: \`${content.baseCommitSha.slice(0, 7)}\``
      : "";
    lines.push(
      "",
      `_Commit: \`${content.commitSha.slice(0, 7)}\`${baseSuffix}_`,
    );
  }
  return lines.join("\n");
}

/**
 * Build the issue-comments path, percent-encoding each `repo` segment for the
 * same reason as `buildCheckRunPath` — `repo` is attacker-controlled ingest
 * input, so reserved chars must not reinterpret the request. `prNumber` and
 * `existingCommentId` are DB integers, not strings. PURE.
 */
export function buildIssueCommentPath(
  repo: string,
  prNumber: number,
  existingCommentId: number | null,
): string {
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  return existingCommentId
    ? `/repos/${encodedRepo}/issues/comments/${existingCommentId}`
    : `/repos/${encodedRepo}/issues/${prNumber}/comments`;
}

/** Statuses worth a row in the comment: the failing verdicts + `flaky`. */
const LISTED_STATUSES = ["failed", "timedout", "interrupted", "flaky"];

interface ListedResultRow {
  id: string;
  testId: string;
  title: string;
  file: string;
  status: string;
}

function toLine(row: ListedResultRow): PrCommentTestLine {
  return { title: row.title, file: row.file, testResultId: row.id };
}

function byFileTitle(a: PrCommentTestLine, b: PrCommentTestLine): number {
  return a.file.localeCompare(b.file) || a.title.localeCompare(b.title);
}

/**
 * Bucket this run's noteworthy results into the comment's sections. PURE.
 * With a diff, new = `newlyFailed` ∪ failing `addedTests` (a brand-new test
 * that fails is a new failure even though the set-diff files it under
 * "added"), known = `stillFailing`. Without a diff every failing row is "new"
 * (rendered as a single "Failures" section — see {@link buildPrCommentBody}).
 */
export function bucketListedResults(
  rows: readonly ListedResultRow[],
  diff: RunDiff | null,
): Pick<PrCommentContent, "newFailures" | "knownFailures" | "flakyTests"> {
  const byTestId = new Map(rows.map((r) => [r.testId, r]));
  const flakyTests = rows
    .filter((r) => r.status === "flaky")
    .map(toLine)
    .sort(byFileTitle);
  const failingRows = rows.filter((r) => verdictOf(r.status) === "failing");

  if (!diff) {
    return {
      newFailures: failingRows.map(toLine).sort(byFileTitle),
      knownFailures: [],
      flakyTests,
    };
  }

  const lookup = (testIds: readonly string[]): PrCommentTestLine[] =>
    testIds
      .map((id) => byTestId.get(id))
      .filter((r): r is ListedResultRow => r !== undefined)
      .map(toLine)
      .sort(byFileTitle);

  return {
    newFailures: lookup([
      ...diff.newlyFailed.map((c) => c.testId),
      ...diff.addedTests
        .filter((a) => verdictOf(a.status) === "failing")
        .map((a) => a.testId),
    ]),
    knownFailures: lookup(diff.stillFailing.map((c) => c.testId)),
    flakyTests,
  };
}

interface StickyRow {
  id: string;
  commentId: number | null;
  runId: string | null;
}

/**
 * Find-or-create the sticky row for `(projectId, repo, prNumber)`. The unique
 * index makes the racing case safe: both inserts target the same identity, one
 * wins, `onConflictDoNothing` swallows the loser, and both read back the same
 * row.
 */
async function ensureStickyRow(
  projectId: string,
  repo: string,
  prNumber: number,
  nowSeconds: number,
): Promise<StickyRow | null> {
  await db
    .insert(githubPrComments)
    .values({
      id: ulid(),
      projectId,
      repo,
      prNumber,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    })
    .onConflictDoNothing();
  const rows = await db
    .select({
      id: githubPrComments.id,
      commentId: githubPrComments.commentId,
      runId: githubPrComments.runId,
    })
    .from(githubPrComments)
    .where(
      and(
        eq(githubPrComments.projectId, projectId),
        eq(githubPrComments.repo, repo),
        eq(githubPrComments.prNumber, prNumber),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically claim the "POST the first comment" slot — the `githubPrComments`
 * twin of `claimCheckRunSlot` (`@/lib/github-checks`, whose doc explains the
 * CAS + TTL mechanics). Only matches while `commentId` is still null and no
 * live claim is held.
 */
async function claimPrCommentSlot(
  rowId: string,
  projectId: string,
  nowSeconds: number,
): Promise<number | null> {
  const result = await db
    .update(githubPrComments)
    .set({ claimedAt: nowSeconds, updatedAt: nowSeconds })
    .where(
      and(
        eq(githubPrComments.id, rowId),
        eq(githubPrComments.projectId, projectId),
        isNull(githubPrComments.commentId),
        or(
          isNull(githubPrComments.claimedAt),
          lt(
            githubPrComments.claimedAt,
            nowSeconds - PR_COMMENT_CLAIM_TTL_SECONDS,
          ),
        ),
      ),
    );
  return changedRows(result) === 1 ? nowSeconds : null;
}

/**
 * PATCH the existing comment or POST a new one; returns the comment id GitHub
 * reports back. A PATCH 404 means a human deleted the sticky comment — fall
 * through to POSTing a fresh one instead of never commenting on the PR again.
 */
async function postComment(
  token: string,
  repo: string,
  prNumber: number,
  body: string,
  existingCommentId: number | null,
): Promise<number | null> {
  if (existingCommentId !== null) {
    const response = await githubFetch(
      buildIssueCommentPath(repo, prNumber, existingCommentId),
      { method: "PATCH", body: JSON.stringify({ body }) },
      token,
    );
    if (response.ok) {
      const json = (await response.json().catch(() => ({}))) as { id?: number };
      return json.id ?? existingCommentId;
    }
    if (response.status !== 404) {
      throw new Error(
        `GitHub PR-comment PATCH failed: ${response.status} ${response.statusText}`,
      );
    }
  }
  const response = await githubFetch(
    buildIssueCommentPath(repo, prNumber, null),
    { method: "POST", body: JSON.stringify({ body }) },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub PR-comment POST failed: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as { id?: number };
  return json.id ?? null;
}

/** Run statuses that count as "the branch's previous result" for the baseline. */
const TERMINAL_STATUSES = ["passed", "failed", "timedout", "interrupted"];

/**
 * The comment's baseline: the most recent TERMINAL run on the same branch
 * created before the head run. Deliberately NOT `resolveBaseRun` (the diff
 * page's last-PASSED anchor): "known failure" means "was already failing on
 * the previous push", and a passed-only baseline contains no failing rows, so
 * `stillFailing` could never be non-empty. Same predicate shape and same-second
 * ULID tie-break as `resolveBaseRun` otherwise, served by
 * `runs_project_branch_created_at_idx`.
 */
async function resolveCommentBaseRun(
  scope: TenantScope,
  headRun: { id: string; branch: string | null; createdAt: number },
): Promise<DiffRunRef | null> {
  const branch = headRun.branch?.trim();
  if (!branch) return null;
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        runScopeWhere(scope),
        eq(runs.branch, branch),
        inArray(runs.status, TERMINAL_STATUSES),
        or(
          lt(runs.createdAt, headRun.createdAt),
          and(eq(runs.createdAt, headRun.createdAt), lt(runs.id, headRun.id)),
        ),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Gather the diff + per-test rows and assemble {@link PrCommentContent}. */
async function buildContent(
  scope: TenantScope,
  runId: string,
  run: {
    status: string;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    durationMs: number;
    branch: string | null;
    commitSha: string | null;
    createdAt: number;
  },
  runUrl: string,
): Promise<PrCommentContent> {
  const base = await resolveCommentBaseRun(scope, {
    id: runId,
    branch: run.branch,
    createdAt: run.createdAt,
  });
  const [diff, listedRows] = await Promise.all([
    computeRunDiff(scope, runId, base),
    db
      .select({
        id: testResults.id,
        testId: testResults.testId,
        title: testResults.title,
        file: testResults.file,
        status: testResults.status,
      })
      .from(testResults)
      .where(
        and(
          childByRunWhere(testResults, scope, runId),
          inArray(testResults.status, LISTED_STATUSES),
        ),
      ),
  ]);
  return {
    projectId: scope.projectId,
    status: run.status,
    passed: run.passed,
    failed: run.failed,
    flaky: run.flaky,
    skipped: run.skipped,
    durationMs: run.durationMs,
    runUrl,
    commitSha: run.commitSha,
    hasBase: base !== null,
    baseCommitSha: base?.commitSha ?? null,
    ...bucketListedResults(listedRows, diff),
  };
}

/**
 * Best-effort: upsert the sticky PR comment for a completed run. Called from
 * the same three terminal paths as `maybePostGithubCheck` (`completeRun`,
 * `completeShardedRun`, `finalizeStaleRun`), takes the same `(runId,
 * projectId)`, and NEVER throws — a GitHub outage must not fail ingest. No-ops
 * cheaply when the App isn't configured, the run isn't PR-associated (no
 * repo/prNumber), or no installation OWNED BY THE RUN'S TEAM matches the repo
 * owner (the same confused-deputy boundary `maybePostGithubCheck` documents:
 * `run.repo` is attacker-controlled ingest input, so the installation must
 * belong to the run's own team).
 *
 * Concurrency, layered on `githubPrComments`:
 *   - First comment: claim-before-POST CAS (see {@link claimPrCommentSlot}) so
 *     concurrent completions never stack duplicate comments; the loser re-reads
 *     once and PATCHes the winner's id if it landed, else skips.
 *   - Later runs: PATCH the recorded id; last writer wins among true
 *     concurrent PATCHes (rare, and both bodies are fresh).
 *   - Ordering: `githubPrComments.runId` records the rendered run; run ids are
 *     ULIDs (time-ordered), so a stale run — e.g. watchdog-finalizing an old
 *     push half an hour late — sees a newer id recorded and declines rather
 *     than regressing the comment to stale content. Known gap: a stale run
 *     that loses only the in-flight PATCH race can still land last; accepted,
 *     the window is two overlapping completions of different runs.
 */
export async function maybePostGithubPrComment(
  runId: string,
  projectId: string,
): Promise<void> {
  if (!githubAppEnabled(env)) return;
  try {
    const rows = await db
      .select({
        teamId: runs.teamId,
        repo: runs.repo,
        prNumber: runs.prNumber,
        branch: runs.branch,
        commitSha: runs.commitSha,
        createdAt: runs.createdAt,
        teamSlug: teams.slug,
        projectSlug: projects.slug,
        status: runs.status,
        passed: runs.passed,
        failed: runs.failed,
        flaky: runs.flaky,
        skipped: runs.skipped,
        durationMs: runs.durationMs,
      })
      .from(runs)
      .innerJoin(teams, eq(teams.id, runs.teamId))
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
      .limit(1);
    const run = rows[0];
    if (!run?.repo || run.prNumber == null) return;

    const owner = parseRepoOwner(run.repo);
    if (!owner) return;

    const installRows = await db
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.teamId, run.teamId),
          eq(githubInstallations.accountLogin, owner),
        ),
      )
      .limit(1);
    const installationId = installRows[0]?.installationId;
    if (!installationId) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const sticky = await ensureStickyRow(
      projectId,
      run.repo,
      run.prNumber,
      nowSeconds,
    );
    if (!sticky) return;
    // Stale-run guard (ULID order): a newer run's summary is already recorded.
    if (sticky.runId !== null && sticky.runId > runId) return;

    let existingCommentId = sticky.commentId;
    let claim: number | null = null;
    if (existingCommentId === null) {
      claim = await claimPrCommentSlot(sticky.id, projectId, nowSeconds);
      if (claim === null) {
        // Lost the claim race — re-read once: PATCH the winner's id if it has
        // landed, otherwise their in-flight POST covers this completion.
        const reread = await db
          .select({ commentId: githubPrComments.commentId })
          .from(githubPrComments)
          .where(
            and(
              eq(githubPrComments.id, sticky.id),
              eq(githubPrComments.projectId, projectId),
            ),
          )
          .limit(1);
        existingCommentId = reread[0]?.commentId ?? null;
        if (existingCommentId === null) return;
      }
    }

    // The tenant boundary was enforced above (run row read by the caller's
    // auth-checked projectId; installation scoped to the run's own team), and
    // slugs come from the joined trusted rows — same trusted-DB-row rationale
    // as `finalizeStaleRun`.
    const scope = makeTenantScope({
      teamId: run.teamId,
      projectId,
      teamSlug: run.teamSlug,
      projectSlug: run.projectSlug,
    });
    const runUrl = `${env.WRIGHTFUL_PUBLIC_URL}/t/${run.teamSlug}/p/${run.projectSlug}/runs/${runId}`;
    const body = buildPrCommentBody(
      await buildContent(scope, runId, run, runUrl),
    );

    const token = await mintInstallationToken(installationId);
    let commentId: number | null;
    try {
      commentId = await postComment(
        token,
        run.repo,
        run.prNumber,
        body,
        existingCommentId,
      );
    } catch (err) {
      if (claim !== null) {
        // Release our claim (only if still ours) so a failure doesn't block a
        // retry/watchdog for the full TTL.
        await db
          .update(githubPrComments)
          .set({ claimedAt: null })
          .where(
            and(
              eq(githubPrComments.id, sticky.id),
              eq(githubPrComments.claimedAt, claim),
            ),
          )
          .catch((releaseErr: unknown) => {
            logger.warn("github pr-comment claim release failed", {
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

    if (commentId !== null) {
      // Persist the comment id + rendered run. CAS: a claimed POST checks the
      // claim is still ours; a PATCH path refuses to regress `runId` past a
      // newer run's already-persisted summary.
      await db
        .update(githubPrComments)
        .set({
          commentId,
          runId,
          claimedAt: null,
          updatedAt: nowSeconds,
        })
        .where(
          and(
            eq(githubPrComments.id, sticky.id),
            claim !== null
              ? eq(githubPrComments.claimedAt, claim)
              : or(
                  isNull(githubPrComments.runId),
                  lte(githubPrComments.runId, runId),
                ),
          ),
        );
    }
  } catch (err) {
    logger.error("github pr-comment post failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
