import { ulid } from "ulid";
import { getControlDb } from "@/control";

/**
 * Helpers for tests running under `@cloudflare/vitest-pool-workers`. Each
 * test file runs against its own miniflare instance, so per-file state
 * (DO data) is cheap to re-establish per test.
 *
 * Per-test DO isolation: use a fresh ULID `teamId` for each test (via
 * `freshTeamId()`). The `TENANT` namespace's `idFromName(teamId)` gives a
 * unique object id, so each test hits a fresh tenant DO with no shared
 * state. The singleton `ControlDO` is shared across tests in the same
 * miniflare instance — fresh ULIDs for team / project / api-key rows keep
 * tests independent.
 */

/** Fresh ULID team id — gives each test its own tenant DO instance. */
export function freshTeamId(): string {
  return ulid();
}

export interface SeededTenant {
  teamId: string;
  teamSlug: string;
  projectId: string;
  projectSlug: string;
  apiKeyId: string;
}

/**
 * Insert a fresh team + project + API key into the singleton ControlDO via
 * its RPC-backed Kysely handle. Returns the identifiers so the test can
 * hand them to the handlers under test. ControlDO migrates itself on first
 * access — no manual schema bootstrap step.
 */
export async function seedTeamAndProject(
  overrides: Partial<SeededTenant> = {},
): Promise<SeededTenant> {
  const teamId = overrides.teamId ?? freshTeamId();
  const projectId = overrides.projectId ?? ulid();
  const apiKeyId = overrides.apiKeyId ?? ulid();
  const teamSlug =
    overrides.teamSlug ?? `team-${teamId.slice(-6).toLowerCase()}`;
  const projectSlug =
    overrides.projectSlug ?? `proj-${projectId.slice(-6).toLowerCase()}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const db = getControlDb();
  await db
    .insertInto("teams")
    .values({
      id: teamId,
      slug: teamSlug,
      name: teamSlug,
      createdAt: nowSeconds,
    })
    .execute();
  await db
    .insertInto("projects")
    .values({
      id: projectId,
      teamId,
      slug: projectSlug,
      name: projectSlug,
      createdAt: nowSeconds,
    })
    .execute();
  await db
    .insertInto("apiKeys")
    .values({
      id: apiKeyId,
      projectId,
      label: "test key",
      keyHash: "hash",
      keyPrefix: "testpref",
      createdAt: nowSeconds,
    })
    .execute();

  return { teamId, teamSlug, projectId, projectSlug, apiKeyId };
}
