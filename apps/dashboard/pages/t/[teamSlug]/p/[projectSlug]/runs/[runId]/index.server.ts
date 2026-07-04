import { defineHandler, type InferProps } from "void";
import { and, db, desc, eq } from "void/db";
import { runs } from "@schema";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { loadProjectBranches } from "@/lib/branches-query";
import { groupKeyId } from "@/lib/group-tests-by-file";
import { loadRunGroupSkeleton } from "@/lib/run-groups-page";
import {
  DEFAULT_RUN_RESULTS_LIMIT,
  loadRunResultsPage,
  type RunResultsResponse,
} from "@/lib/run-results-page";
import { RUN_PUBLIC_COLUMNS } from "@/lib/run-columns";
import { runByIdWhere, runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;
/** Default group-by axis for the Tests tab's first paint. */
const DEFAULT_GROUP_BY = "file" as const;

/**
 * Run detail loader. Resolves the active run + its history strip + the Tests-tab
 * GROUP SKELETON (worst-first headers with per-bucket counts) plus the first row
 * page of the auto-expanded worst groups — all in one batch. Collapsed groups
 * ship header-only and lazy-load their rows on expand (client TanStack query).
 * The page subscribes via `useRunRoom(runId)`: the summary drives the live filter
 * chips, and live `changedTests` merge into whichever groups are loaded.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  if (!runId) throw new Response("Not Found", { status: 404 });

  const { project, scope } = requireTenantContext(c);

  const runRows = await db
    // Explicit projection — omits idempotencyKey (the write-reopen credential)
    // from the serialized props. See RUN_PUBLIC_COLUMNS.
    .select(RUN_PUBLIC_COLUMNS)
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const branchParam = url.searchParams.get("branch");
  const defaultBranch = run.branch ?? ALL_BRANCHES;
  const effectiveBranch = branchParam ?? defaultBranch;
  const tabParam = url.searchParams.get("tab");
  const tab: "tests" | "env" = tabParam === "env" ? "env" : "tests";

  // History: last HISTORY_LIMIT runs, optionally filtered by branch.
  const historyConditions = [runScopeWhere(scope)];
  if (effectiveBranch !== ALL_BRANCHES) {
    historyConditions.push(eq(runs.branch, effectiveBranch));
  }
  const [history, branches, skeleton] = await Promise.all([
    db
      .select({
        id: runs.id,
        status: runs.status,
        durationMs: runs.durationMs,
        createdAt: runs.createdAt,
        branch: runs.branch,
        commitSha: runs.commitSha,
        commitMessage: runs.commitMessage,
      })
      .from(runs)
      .where(and(...historyConditions))
      .orderBy(desc(runs.createdAt))
      .limit(HISTORY_LIMIT),
    loadProjectBranches(scope),
    // The Tests-tab group skeleton (worst-first headers + per-bucket counts) —
    // only needed on the Tests tab, so the Environment tab skips it (and the
    // per-group row fan-out below) entirely. The run select() above already
    // confirmed ownership, so skip the re-probe.
    tab === "tests"
      ? loadRunGroupSkeleton(scope, runId, {
          groupBy: DEFAULT_GROUP_BY,
          status: null,
          search: null,
          skipOwnershipCheck: true,
        })
      : Promise.resolve(null),
  ]);

  // Seed the first row page of every auto-expanded (worst) group so the initial
  // paint shows them populated with no client round-trip; collapsed groups
  // fetch their rows lazily on expand. Keyed by the client-stable `groupKeyId`.
  const expandedGroups: Record<string, RunResultsResponse> = {};
  if (skeleton) {
    const expandedPages = await Promise.all(
      skeleton.groups
        .filter((g) => g.expandedByDefault)
        .map(async (g) => {
          const page = await loadRunResultsPage(scope, runId, {
            cursor: null,
            limit: DEFAULT_RUN_RESULTS_LIMIT,
            status: null,
            group: { axis: DEFAULT_GROUP_BY, key: g.key },
            skipOwnershipCheck: true,
          });
          return [groupKeyId(g.key), page] as const;
        }),
    );
    for (const [id, page] of expandedPages) {
      if (page) expandedGroups[id] = page;
    }
  }

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      role: project.role,
    },
    run,
    runId,
    history,
    branches,
    branchParam,
    defaultBranch,
    effectiveBranch,
    tab,
    pathname: url.pathname,
    groupBy: DEFAULT_GROUP_BY,
    skeleton: skeleton ?? {
      groupBy: DEFAULT_GROUP_BY,
      groups: [],
      truncated: false,
    },
    expandedGroups,
    // Whether the run is sharded — gates the "Shard" group-by option. Read off
    // the run's declared shard total (set at open from config.shard.total) so
    // it's known before any row loads, not derived from the loaded rows.
    isSharded: run.expectedShards != null,
  };
});
