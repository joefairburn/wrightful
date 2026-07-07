import { defer, defineHandler, type InferProps } from "void";
import { and, db, desc, eq } from "void/db";
import { runs, testResults } from "@schema";
import { listTeamMembers } from "@/lib/auth-users";
import { resolveTestOwners } from "@/lib/owners-repo";
import { loadQuarantineByTestId } from "@/lib/quarantine-repo";
import { RUN_PUBLIC_COLUMNS } from "@/lib/run-columns";
import { childByTestIdWhere, runByIdWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";
import { loadAttemptArtifactGroups } from "@/lib/test-artifact-actions";
import { loadTestResultChildren } from "@/lib/test-result-children";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;

/**
 * Test detail loader. One async batch:
 *   - the testResults row (404 if it doesn't belong to the supplied run)
 *   - run-level metadata (playwrightVersion for the Environment rail)
 *   - tags + annotations
 *   - per-attempt rows (errorMessage / status)
 *   - last 30 history rows for the same `testId`
 *
 * Artifact presentation (signed download/trace URLs, visual-diff grouping,
 * per-attempt ordering) is owned by `loadAttemptArtifactGroups` — the page
 * receives finished `AttemptArtifactGroup`s. The raw R2 object key and the
 * download tokens are consumed server-side and never serialized to the client.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  const testResultId = c.req.param("testResultId");
  if (!runId || !testResultId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(c.req.url);
  const origin = url.origin;

  const { project, scope } = requireTenantContext(c);

  const [resultRows, runRows] = await Promise.all([
    db
      .select()
      .from(testResults)
      .where(
        and(
          eq(testResults.projectId, project.id),
          eq(testResults.id, testResultId),
          eq(testResults.runId, runId),
        ),
      )
      .limit(1),
    db
      .select(RUN_PUBLIC_COLUMNS)
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .limit(1),
  ]);
  const result = resultRows[0];
  const run = runRows[0];

  if (!result || !run) {
    return {
      kind: "not_found" as const,
      project: {
        teamSlug: project.teamSlug,
        projectSlug: project.slug,
      },
      runId,
    };
  }

  // Eager batch: the tags + annotations + per-attempt child rows (shared with
  // the MCP get_test_result surface via `loadTestResultChildren` so the
  // projections + project-scoping can't drift) alongside quarantine state —
  // all tiny point/index reads that drive the above-the-fold header, metadata,
  // attempt tabs and error panels. Fired together so the fan-out stays
  // concurrent. The two costly reads (the bounded history strip and the
  // per-row artifact-signing fan-out) defer below.
  const [children, quarantineRows, ownerMap, members] = await Promise.all([
    loadTestResultChildren(scope, testResultId),
    // Quarantine state for this test — drives the badge + owner-gated control
    // in the page header. One testId, so at most one row.
    loadQuarantineByTestId(project.id, [result.testId]),
    // The test's owners (manual + CODEOWNERS-derived, manual-wins) — chips +
    // the assign popover in the header.
    resolveTestOwners(scope, [result.testId]),
    // The assign popover's member options — only loaded for owners (the only
    // viewers who get the control).
    project.role === "owner"
      ? listTeamMembers(project.teamId)
      : Promise.resolve([]),
  ]);

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    kind: "ok" as const,
    project: {
      id: project.id,
      teamSlug: project.teamSlug,
      projectSlug: project.slug,
      teamName: project.teamName,
      // Owner-only quarantine control; non-owners see only the badge.
      canManageQuarantine: project.role === "owner",
      // Owner-only test-ownership assign popover; non-owners see only chips.
      canManageOwners: project.role === "owner",
    },
    runId,
    testResultId,
    result,
    run,
    // Quarantine state for this test (null = not quarantined) + where to land
    // after the mutation (back on this page). `quarantineError` surfaces a
    // banner when the mutation route bounces back with ?quarantineError=.
    quarantine: quarantineRows[0]
      ? { mode: quarantineRows[0].mode, reason: quarantineRows[0].reason }
      : null,
    quarantineRedirectTo: url.pathname + url.search,
    quarantineError: url.searchParams.get("quarantineError"),
    // This test's resolved owners + (for owners) the member options the assign
    // popover selects from. `ownerError` mirrors `quarantineError`.
    owners: ownerMap.get(result.testId) ?? [],
    assignableMembers: members.map((m) => ({ name: m.name, email: m.email })),
    ownerError: url.searchParams.get("ownerError"),
    tags: children.tags,
    annotations: children.annotations,
    attempts: children.attempts,

    // Below-the-fold duration-history strip — a bounded 30-row testId scan,
    // deferred behind the shared RunHistoryChart skeleton.
    history: defer(async () =>
      db
        .select({
          testResultId: testResults.id,
          runId: testResults.runId,
          status: testResults.status,
          durationMs: testResults.durationMs,
          createdAt: testResults.createdAt,
          branch: runs.branch,
          commitSha: runs.commitSha,
        })
        .from(testResults)
        .innerJoin(runs, eq(runs.id, testResults.runId))
        .where(childByTestIdWhere(testResults, scope, result.testId))
        .orderBy(desc(testResults.createdAt))
        .limit(HISTORY_LIMIT),
    ),

    // Server-owned artifact presentation for the right rail: signed URLs +
    // visual grouping + per-attempt ordering. This is the per-row token-signing
    // / SigV4 presign FAN-OUT — the page's most expensive read — so it streams
    // behind the rail skeleton. Raw r2Key / tokens stay inside this call; the
    // page receives finished, serializable AttemptArtifactGroups (Map → array).
    // (Note: dropping the old `maxObservedAttempt` term keeps the eager attempt
    // tab count on `retryCount + 1`, so the left column never reads this.)
    artifacts: defer(async () => {
      const artifactGroupMap = await loadAttemptArtifactGroups(
        scope,
        testResultId,
        origin,
      );
      return { artifactGroups: Array.from(artifactGroupMap.values()) };
    }),
  };
});
