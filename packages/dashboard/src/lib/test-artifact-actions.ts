import type { ArtifactAction } from "@/app/components/artifact-actions";
import { signArtifactToken } from "@/lib/artifact-tokens";
import type { TenantScope } from "@/tenant";

// Order within an attempt: trace first (most useful for debugging), then
// video, screenshot, everything else. `other` covers error-context /
// copy-prompt artifacts that aren't rendered in the action row.
const TYPE_ORDER: Record<string, number> = {
  trace: 0,
  video: 1,
  screenshot: 2,
  other: 3,
};

/**
 * Which attempt carries the error for a test with the given final status
 * and total number of attempts. Shared by the test detail page (which shows
 * per-attempt errors) and the run detail page (which shows a single error
 * block per failing test).
 *
 *  - `failed` / `timedout` → last attempt
 *  - `flaky` → first attempt (the passing retry isn't where the error lives)
 *  - otherwise → null (no error to show)
 */
export function errorAttempt(
  finalStatus: string,
  totalAttempts: number,
): number | null {
  if (finalStatus === "failed" || finalStatus === "timedout") {
    return totalAttempts - 1;
  }
  if (finalStatus === "flaky") return 0;
  return null;
}

/** Build a trace.playwright.dev link wrapping a presigned R2 GET URL. */
export function traceViewerUrl(
  origin: string,
  artifactId: string,
  token: string,
): string {
  const downloadUrl = `${origin}/api/artifacts/${artifactId}/download?t=${encodeURIComponent(token)}`;
  return `https://trace.playwright.dev/?trace=${encodeURIComponent(downloadUrl)}`;
}

export interface ArtifactRow {
  id: string;
  testResultId: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  attempt: number;
  r2Key: string;
}

/**
 * Convert a raw artifact row into the client-facing `ArtifactAction` the UI
 * renders. Shared between `test-detail.tsx` (per-attempt, all types) and
 * `run-detail.tsx` (failing-attempt, media types).
 */
export function toArtifactAction(
  row: Pick<ArtifactRow, "id" | "type" | "name" | "contentType">,
  origin: string,
  token: string,
): ArtifactAction {
  const downloadHref = `/api/artifacts/${row.id}/download?t=${encodeURIComponent(token)}`;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    contentType: row.contentType,
    downloadHref,
    traceViewerUrl:
      row.type === "trace" ? traceViewerUrl(origin, row.id, token) : undefined,
  };
}

export interface FailingTestInput {
  id: string;
  status: string;
  retryCount: number;
}

/**
 * Load media artifacts (`trace`, `video`, `screenshot`) for the failing
 * attempt of each supplied test result. Returns a map keyed by
 * `testResultId` with the already-signed `ArtifactAction[]`, sorted by
 * `TYPE_ORDER` then name.
 *
 * Takes a pre-authorized `TenantScope` (or anything with a `db` handle
 * for the tenant DB, e.g. `ActiveProject`). The artifacts table lives in
 * the team's DO, never the control D1.
 */
export async function loadFailingArtifactActions(
  tenantDb: Pick<TenantScope, "db">["db"],
  failingTests: FailingTestInput[],
  origin: string,
): Promise<Record<string, ArtifactAction[]>> {
  const relevant = failingTests.filter(
    (t) =>
      t.status === "failed" || t.status === "timedout" || t.status === "flaky",
  );
  if (relevant.length === 0) return {};

  const rows = await tenantDb
    .selectFrom("artifacts")
    .select([
      "id",
      "testResultId",
      "type",
      "name",
      "contentType",
      "attempt",
      "r2Key",
    ])
    .where(
      "testResultId",
      "in",
      relevant.map((t) => t.id),
    )
    .orderBy("attempt", "asc")
    .execute();

  // Group artifacts by testResultId.
  const byTest = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byTest.get(row.testResultId) ?? [];
    bucket.push(row);
    byTest.set(row.testResultId, bucket);
  }

  const out: Record<string, ArtifactAction[]> = {};
  await Promise.all(
    relevant.map(async (t) => {
      const bucket = byTest.get(t.id) ?? [];
      if (bucket.length === 0) return;
      const maxObservedAttempt = Math.max(...bucket.map((a) => a.attempt));
      const totalAttempts = Math.max(t.retryCount + 1, maxObservedAttempt + 1);
      const target = errorAttempt(t.status, totalAttempts);
      if (target === null) return;
      const forAttempt = bucket
        .filter((a) => a.attempt === target && a.type !== "other")
        .sort((x, y) => {
          const dx = TYPE_ORDER[x.type] ?? 99;
          const dy = TYPE_ORDER[y.type] ?? 99;
          if (dx !== dy) return dx - dy;
          return x.name.localeCompare(y.name);
        });
      if (forAttempt.length === 0) return;
      const actions = await Promise.all(
        forAttempt.map(async (a) => {
          const token = await signArtifactToken({
            r2Key: a.r2Key,
            contentType: a.contentType,
          });
          return toArtifactAction(a, origin, token);
        }),
      );
      out[t.id] = actions;
    }),
  );
  return out;
}
