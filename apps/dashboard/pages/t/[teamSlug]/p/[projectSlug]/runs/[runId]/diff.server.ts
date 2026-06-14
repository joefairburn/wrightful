import { defineHandler, type InferProps } from "void";
import { and, db, desc, eq } from "void/db";
import { runs } from "@schema";
import { runScopeWhere } from "@/lib/scope";
import {
  diffRuns,
  loadDiffRunRef,
  loadRunTestStatuses,
  resolveBaseRun,
} from "@/lib/run-diff";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const BASE_CANDIDATE_LIMIT = 20;

/**
 * Run-diff loader (roadmap 2.4). Loads the head run (project-scoped), resolves
 * a base — an explicit `?base=<runId>` validated via the project-scoped run
 * lookup, else the most recent passing run on the same branch — then diffs the
 * two runs' per-test statuses with the pure `diffRuns`.
 *
 * Renders an empty state (no diff) when there is no suitable base: a head run
 * with no branch, or no prior passing run on the branch, or an invalid
 * `?base`.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  if (!runId) throw new Response("Not Found", { status: 404 });

  const { project, scope } = requireTenantContext(c);

  const head = await loadDiffRunRef(scope, runId);
  if (!head) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const baseParam = url.searchParams.get("base");

  // Resolve the base run. An explicit `?base` is validated via the same
  // project-scoped lookup as the head (a foreign/missing id → no base, not a
  // 404 — the page degrades to the empty state). Otherwise auto-resolve.
  let base = null;
  if (baseParam && baseParam !== runId) {
    base = await loadDiffRunRef(scope, baseParam);
  } else if (!baseParam) {
    base = await resolveBaseRun(scope, head);
  }

  // Candidate base runs for the selector: recent runs on the same branch other
  // than the head. Cheap, served by `runs_project_branch_created_at_idx`. A
  // null OR empty/whitespace branch has no "same branch" group (an empty string
  // must not match every other branchless run via `eq(branch, "")`).
  const headBranch = head.branch?.trim() ? head.branch : null;
  const baseCandidatesPromise =
    headBranch === null
      ? Promise.resolve([])
      : db
          .select({
            id: runs.id,
            status: runs.status,
            commitSha: runs.commitSha,
            commitMessage: runs.commitMessage,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .where(and(runScopeWhere(scope), eq(runs.branch, headBranch)))
          .orderBy(desc(runs.createdAt))
          .limit(BASE_CANDIDATE_LIMIT);

  // Load both runs' test statuses in parallel (only if we have a base).
  const [headStatuses, baseStatuses, baseCandidates] = await Promise.all([
    loadRunTestStatuses(scope, runId),
    base ? loadRunTestStatuses(scope, base.id) : Promise.resolve([]),
    baseCandidatesPromise,
  ]);

  const diff = base ? diffRuns(baseStatuses, headStatuses) : null;

  return {
    project: {
      slug: project.slug,
      teamSlug: project.teamSlug,
    },
    head,
    base,
    diff,
    // Counts the page renders without re-deriving from `diff` arrays.
    counts: diff
      ? {
          newlyFailed: diff.newlyFailed.length,
          newlyPassed: diff.newlyPassed.length,
          stillFailing: diff.stillFailing.length,
          flakyDeltas: diff.flakyDeltas.length,
          addedTests: diff.addedTests.length,
          removedTests: diff.removedTests.length,
        }
      : null,
    baseCandidates: baseCandidates.filter((r) => r.id !== runId),
    pathname: url.pathname,
  };
});
