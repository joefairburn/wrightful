import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { ulid } from "ulid";

/**
 * Helpers for tests running under `@cloudflare/vitest-pool-workers`. Each
 * test file runs against its own miniflare instance, so per-file state
 * (migrations applied, seed rows) is cheap to re-establish in `beforeAll`.
 *
 * Per-test DO isolation: use a fresh ULID `teamId` for each test (via
 * `freshTeamId()`). The DO namespace's `idFromName(teamId)` gives a unique
 * object id, so each test hits a fresh tenant DO with no shared state.
 */

// The test wrangler config injects this via miniflare.bindings — see
// `vitest.config.ts`. Not declared in worker-configuration.d.ts (that file
// is generated from wrangler.jsonc, which doesn't know about test-only
// bindings), so we narrow locally.
interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}
const testEnv = env as unknown as TestEnv;

let controlSchemaApplied = false;

/**
 * Apply the control-D1 init migration once per miniflare instance (per test
 * file). Safe to call multiple times — subsequent calls are no-ops once
 * the migrations table records the initial run.
 */
export async function ensureControlSchema(): Promise<void> {
  if (controlSchemaApplied) return;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  controlSchemaApplied = true;
}

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
 * Apply the control-DB schema (idempotent) and insert a fresh team +
 * project + API key row set. Returns the identifiers so the test can
 * hand them to the handlers under test.
 */
export async function seedTeamAndProject(
  overrides: Partial<SeededTenant> = {},
): Promise<SeededTenant> {
  await ensureControlSchema();

  const teamId = overrides.teamId ?? freshTeamId();
  const projectId = overrides.projectId ?? ulid();
  const apiKeyId = overrides.apiKeyId ?? ulid();
  const teamSlug =
    overrides.teamSlug ?? `team-${teamId.slice(-6).toLowerCase()}`;
  const projectSlug =
    overrides.projectSlug ?? `proj-${projectId.slice(-6).toLowerCase()}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
    ).bind(teamId, teamSlug, teamSlug, nowSeconds),
    testEnv.DB.prepare(
      "INSERT INTO projects (id, team_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, teamId, projectSlug, projectSlug, nowSeconds),
    testEnv.DB.prepare(
      `INSERT INTO api_keys
         (id, project_id, label, key_hash, key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(apiKeyId, projectId, "test key", "hash", "testpref", nowSeconds),
  ]);

  return { teamId, teamSlug, projectId, projectSlug, apiKeyId };
}
