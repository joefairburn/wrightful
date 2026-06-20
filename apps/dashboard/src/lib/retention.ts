import { and, db, eq, inArray, lt } from "void/db";
import { artifacts, projects, teams, testResults } from "@schema";
import { deleteArtifactObjectsByKeys } from "@/lib/artifacts";
import { runBatch } from "@/lib/db-batch";
import { chunkByParams, PG_MAX_BOUND_PARAMS } from "@/lib/ingest";

/**
 * Two-axis data retention sweep.
 *
 * Enforces two independent, separately-configurable windows because their
 * cost/value profiles differ:
 *
 *   - **Artifact bytes** (`retentionArtifactDays`, default 30) — the R2 storage
 *     cost. Expired artifacts have their R2 objects AND rows deleted.
 *   - **testResults rows** (`retentionTestResultsDays`, default 90) — the
 *     Postgres row-storage cost. Expired testResults are deleted; the FK cascade
 *     removes their attempts/tags/annotations/artifact ROWS. `runs` summary rows
 *     are kept (the aggregate counters live there), so run history outlives its
 *     detail.
 *
 * Modeled on the stale-run watchdog (`sweepStaleRuns`): a bounded slice per
 * project per pass (`limit`) so a large backlog drains across successive daily
 * passes rather than blowing the Workers subrequest budget. Per-project (not
 * global) so each query rides the `(projectId, createdAt)` index, and so each
 * project picks up its team's window.
 *
 * Orphan-free by construction: the artifact-age pass deletes R2 objects before
 * rows, and the testResults pass ALSO deletes the R2 objects of the artifacts it
 * is about to cascade-delete — so an expiring testResult never strands live R2
 * bytes, regardless of window config or an artifact-sweep backlog.
 */

const SECONDS_PER_DAY = 86_400;

export interface RetentionWindows {
  artifactDays: number;
  testResultDays: number;
}

/** A team's effective windows: per-team override, else the env default. PURE. */
export function resolveRetentionWindows(
  team: {
    retentionArtifactDays: number | null;
    retentionTestResultsDays: number | null;
  },
  defaults: RetentionWindows,
): RetentionWindows {
  return {
    artifactDays: team.retentionArtifactDays ?? defaults.artifactDays,
    testResultDays: team.retentionTestResultsDays ?? defaults.testResultDays,
  };
}

export interface RetentionSweepResult {
  artifactsDeleted: number;
  artifactObjectsDeleted: number;
  testResultsDeleted: number;
}

/**
 * Chunk a set of ids so a `WHERE projectId = $1 AND <col> IN (chunk)` statement
 * stays under Postgres's per-statement bound-param ceiling. Each id binds one
 * param AND the statement carries one fixed bind (`projectId`), so the ceiling is
 * reserved by one (`PG_MAX_BOUND_PARAMS - 1`): a full chunk binds `ids.length +
 * 1 <= 65_535`, never overflowing. The cap itself stays in its single home —
 * `PG_MAX_BOUND_PARAMS` / `chunkByParams` in ingest.ts — so there is no
 * chunk-size magic number to drift (this used to be a stale D1 99-param
 * `ID_DELETE_CHUNK`).
 */
export function chunkIdsForInList(ids: string[]): string[][] {
  return chunkByParams(ids, 1, PG_MAX_BOUND_PARAMS - 1);
}

/** Delete project-scoped rows by id, chunked under the bound-param cap, in one batch. */
async function deleteRowsByIds(
  table: typeof artifacts | typeof testResults,
  projectId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await runBatch((tx) =>
    chunkIdsForInList(ids).map((chunk) =>
      tx
        .delete(table)
        .where(and(eq(table.projectId, projectId), inArray(table.id, chunk))),
    ),
  );
}

/** Sweep one project's artifacts older than `cutoff` (R2 objects, then rows). */
async function sweepProjectArtifacts(
  projectId: string,
  cutoff: number,
  limit: number,
): Promise<{ rows: number; objects: number }> {
  const rows = await db
    .select({ id: artifacts.id, r2Key: artifacts.r2Key })
    .from(artifacts)
    .where(
      and(eq(artifacts.projectId, projectId), lt(artifacts.createdAt, cutoff)),
    )
    .limit(limit);
  if (rows.length === 0) return { rows: 0, objects: 0 };

  // R2 first, rows second: an orphaned row whose bytes are gone 404s harmlessly
  // (and a re-sweep mops it up), whereas an orphaned R2 object is unreferenced.
  const objects = await deleteArtifactObjectsByKeys(rows.map((r) => r.r2Key));
  await deleteRowsByIds(
    artifacts,
    projectId,
    rows.map((r) => r.id),
  );
  return { rows: rows.length, objects };
}

/** Sweep one project's testResults older than `cutoff` (cascades children). */
async function sweepProjectTestResults(
  projectId: string,
  cutoff: number,
  limit: number,
): Promise<{ rows: number; objects: number }> {
  const rows = await db
    .select({ id: testResults.id })
    .from(testResults)
    .where(
      and(
        eq(testResults.projectId, projectId),
        lt(testResults.createdAt, cutoff),
      ),
    )
    .limit(limit);
  if (rows.length === 0) return { rows: 0, objects: 0 };
  const ids = rows.map((r) => r.id);

  // Clean the R2 objects of artifacts the FK cascade is about to delete, so a
  // testResult expiring before its artifacts (misconfigured window, or an
  // artifact-sweep backlog) never strands live bytes.
  let objects = 0;
  for (const chunk of chunkIdsForInList(ids)) {
    const arts = await db
      .select({ r2Key: artifacts.r2Key })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.projectId, projectId),
          inArray(artifacts.testResultId, chunk),
        ),
      );
    if (arts.length > 0) {
      objects += await deleteArtifactObjectsByKeys(arts.map((a) => a.r2Key));
    }
  }

  await deleteRowsByIds(testResults, projectId, ids);
  return { rows: rows.length, objects };
}

/**
 * Sweep every project against its team's retention windows, bounded by `limit`
 * rows per axis per project. The whole policy lives here; the cron is a thin
 * adapter that maps env config in and logs the tally out.
 */
export async function sweepRetention(opts: {
  now: number;
  limit: number;
  defaults: RetentionWindows;
}): Promise<RetentionSweepResult> {
  const projectRows = await db
    .select({
      id: projects.id,
      retentionArtifactDays: teams.retentionArtifactDays,
      retentionTestResultsDays: teams.retentionTestResultsDays,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId));

  let artifactsDeleted = 0;
  let artifactObjectsDeleted = 0;
  let testResultsDeleted = 0;

  for (const p of projectRows) {
    const windows = resolveRetentionWindows(p, opts.defaults);
    const artifactCutoff = opts.now - windows.artifactDays * SECONDS_PER_DAY;
    const testResultCutoff =
      opts.now - windows.testResultDays * SECONDS_PER_DAY;

    const a = await sweepProjectArtifacts(p.id, artifactCutoff, opts.limit);
    artifactsDeleted += a.rows;
    artifactObjectsDeleted += a.objects;

    const t = await sweepProjectTestResults(p.id, testResultCutoff, opts.limit);
    testResultsDeleted += t.rows;
    artifactObjectsDeleted += t.objects;
  }

  return { artifactsDeleted, artifactObjectsDeleted, testResultsDeleted };
}
