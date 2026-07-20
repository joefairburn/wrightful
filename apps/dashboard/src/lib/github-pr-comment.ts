import { and, db, eq, inArray, isNull, lt, lte, or } from "void/db";
import { logger } from "void/log";
import { ulid } from "ulid";
import { githubPrComments, testResults } from "@schema";
import { changedRows } from "@/lib/db-batch";
import { githubFetch } from "@/lib/github-http";
import type { GithubRunContext } from "@/lib/github-run-context";
import {
  runHeadline,
  runSummaryTable,
  statusToConclusion,
} from "@/lib/github-run-render";
import { githubWriteId, postWithClaimedSlot } from "@/lib/github-surface-post";
import { computeRunDiff, resolveBaseRun, verdictOf } from "@/lib/run-diff";
import type { RunDiff } from "@/lib/run-diff";
import { TERMINAL_RUN_STATUSES } from "@/lib/schemas";
import { childByRunWhere } from "@/lib/scope";

/** Upserts the App-posted run summary into one comment per project and PR. */

// Must outlive the token-mint and comment requests.
const PR_COMMENT_CLAIM_TTL_SECONDS = 120;

const MAX_LISTED_TESTS = 10;

/** Marker distinct from the reporter fallback and scoped to one project. */
export function prCommentMarker(projectId: string): string {
  return `<!-- wrightful:pr-summary:${projectId} -->`;
}

export interface PrCommentTestLine {
  title: string;
  file: string;
  testResultId: string | null;
}

export interface PrCommentContent {
  projectId: string;
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  runUrl: string;
  commitSha: string | null;
  hasBase: boolean;
  baseCommitSha: string | null;
  newFailures: PrCommentTestLine[];
  knownFailures: PrCommentTestLine[];
  flakyTests: PrCommentTestLine[];
}

/** Escape user-authored titles for Markdown link text. */
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

export function buildPrCommentBody(content: PrCommentContent): string {
  const conclusion = statusToConclusion(content.status);
  const emoji =
    conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⚪";

  const lines = [
    prCommentMarker(content.projectId),
    `### ${emoji} Wrightful — ${runHeadline(content)}`,
    "",
    ...runSummaryTable(content),
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

/** Build an issue-comment path without trusting the ingested repository name. */
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

/** Bucket failures and flakes into the rendered comment sections. */
export function bucketListedResults(
  rows: readonly ListedResultRow[],
  diff: RunDiff | null,
): Pick<PrCommentContent, "newFailures" | "knownFailures" | "flakyTests"> {
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

  const byTestId = new Map(rows.map((r) => [r.testId, r]));
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

/** Find or create the row protected by the project/repository/PR unique index. */
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

/** Claim the first-comment POST slot while no live claim or comment exists. */
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

/** Update the sticky comment, recreating it if the recorded comment was deleted. */
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
  return githubWriteId(
    buildIssueCommentPath(repo, prNumber, null),
    "POST",
    { body },
    token,
    "PR-comment",
  );
}

/**
 * Assemble a completed run's PR-comment content from an already-resolved
 * {@link GithubRunContext}. Uses the previous TERMINAL run (not just the
 * diff page's last-*passed* run) as the diff baseline, via
 * `resolveBaseRun(..., { statuses: TERMINAL_RUN_STATUSES })`, so a failure
 * already present on the previous push's run classifies as known rather than
 * reading as new.
 */
async function buildContent(
  context: GithubRunContext,
): Promise<PrCommentContent> {
  const { scope, runId } = context;
  const base = await resolveBaseRun(
    scope,
    { id: runId, branch: context.branch, createdAt: context.createdAt },
    { statuses: TERMINAL_RUN_STATUSES },
  );
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
    projectId: context.projectId,
    status: context.status,
    passed: context.passed,
    failed: context.failed,
    flaky: context.flaky,
    skipped: context.skipped,
    durationMs: context.durationMs,
    runUrl: context.runUrl,
    commitSha: context.commitSha,
    hasBase: base !== null,
    baseCommitSha: base?.commitSha ?? null,
    ...bucketListedResults(listedRows, diff),
  };
}

/**
 * Post/update the sticky PR comment for a resolved {@link GithubRunContext}.
 * Best-effort: NEVER throws — it logs and swallows its own errors, so a
 * GitHub outage neither fails ingest nor suppresses the sibling check-run
 * surface (see `postGithubRunSurfaces`). No-ops when the run has no
 * `prNumber` (nothing to comment on).
 */
export async function postPrCommentSurface(
  context: GithubRunContext,
): Promise<void> {
  const { runId, projectId, repo, prNumber } = context;
  try {
    if (!repo || prNumber == null) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const sticky = await ensureStickyRow(projectId, repo, prNumber, nowSeconds);
    if (!sticky) return;
    // `runId`s are ULIDs, so lexicographic order == creation order; a sticky
    // row already stamped by a GREATER runId was updated by a later run, so
    // this (older) finalize must not clobber it.
    if (sticky.runId !== null && sticky.runId > runId) return;

    await postWithClaimedSlot(
      "pr-comment",
      runId,
      sticky.commentId,
      {
        claim: (now) => claimPrCommentSlot(sticky.id, projectId, now),
        readId: async () => {
          const rows = await db
            .select({ commentId: githubPrComments.commentId })
            .from(githubPrComments)
            .where(
              and(
                eq(githubPrComments.id, sticky.id),
                eq(githubPrComments.projectId, projectId),
              ),
            )
            .limit(1);
          return rows[0]?.commentId ?? null;
        },
        release: async (claim) => {
          await db
            .update(githubPrComments)
            .set({ claimedAt: null })
            .where(
              and(
                eq(githubPrComments.id, sticky.id),
                eq(githubPrComments.claimedAt, claim),
              ),
            );
        },
        persist: async (id, claim) => {
          // Keep claimed POSTs and later-run PATCHes from overwriting newer
          // state: CAS on our own claim, or on the runId monotonic guard.
          await db
            .update(githubPrComments)
            .set({
              commentId: id,
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
        },
      },
      async (existingId) => {
        const body = buildPrCommentBody(await buildContent(context));
        return postComment(context.token, repo, prNumber, body, existingId);
      },
    );
  } catch (err) {
    logger.error("github pr-comment post failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
