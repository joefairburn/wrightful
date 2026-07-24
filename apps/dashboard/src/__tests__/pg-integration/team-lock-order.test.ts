// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { buildHarness } = await import("./harness");
  return buildHarness();
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});

const { resetTables } = await import("./harness");
const { createMonitor } = await import("@/lib/monitors/monitors-repo");
const { teardownTeamRows } = await import("@/lib/project-teardown");
const { makeTenantScope } = await import("@/lib/scope");
const { monitors, projectArtifactCleanupJobs, projects, teams } =
  await import("../../../db/schema");

afterAll(async () => {
  await h.client.close();
});

const postgresUrl = process.env.PG_TEST_URL;

describe.skipIf(!postgresUrl)(
  "team parent lock ordering (real Postgres)",
  () => {
    it("waits on teardown's parent lock before taking the project quota lock", async () => {
      await resetTables(h.client, [teams, projects, monitors]);
      await h.db.insert(teams).values({
        id: "lock-team",
        slug: "lock",
        name: "Lock",
        tier: "free",
        createdAt: 1,
      });
      await h.db.insert(projects).values({
        id: "lock-project",
        teamId: "lock-team",
        slug: "lock",
        name: "Lock",
        createdAt: 1,
      });

      const { Client } = await import("pg");
      const blocker = new Client({ connectionString: postgresUrl });
      const observer = new Client({ connectionString: postgresUrl });
      await blocker.connect();
      await observer.connect();
      let pending: Promise<unknown> | undefined;

      try {
        await blocker.query("begin");
        await blocker.query(
          'select "id" from "teams" where "id" = $1 for update',
          ["lock-team"],
        );

        pending = createMonitor(
          makeTenantScope({
            teamId: "lock-team",
            projectId: "lock-project",
            teamSlug: "lock",
            projectSlug: "lock",
          }),
          {
            type: "browser",
            name: "parent-first",
            source: "test('lock order', () => {})",
            intervalSeconds: 300,
            enabled: true,
          },
          "owner",
          2,
          { limit: 1 },
        );

        await vi.waitFor(
          async () => {
            const waiting = await observer.query<{ count: string }>(
              `select count(*)::text as count
               from pg_stat_activity
              where pid <> pg_backend_pid()
                and wait_event_type = 'Lock'
                and query ilike '%from "teams"%for key share%'`,
            );
            expect(Number(waiting.rows[0]?.count ?? 0)).toBeGreaterThan(0);
          },
          { timeout: 5_000, interval: 25 },
        );

        // The child writer is blocked at the parent and therefore cannot already
        // hold the project row. Teardown can continue down the same parent→child
        // order without forming the old parent/project cycle.
        await expect(
          blocker.query(
            'select "id" from "projects" where "id" = $1 for update nowait',
            ["lock-project"],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        await blocker.end();
        await observer.end();
      }

      await expect(pending).resolves.toMatchObject({ name: "parent-first" });
    });

    it("samples cleanup time only after capability holders release the parent", async () => {
      await resetTables(h.client, [
        teams,
        projects,
        projectArtifactCleanupJobs,
      ]);
      await h.db.insert(teams).values({
        id: "baseline-team",
        slug: "baseline",
        name: "Baseline",
        tier: "free",
        createdAt: 1,
      });
      await h.db.insert(projects).values({
        id: "baseline-project",
        teamId: "baseline-team",
        slug: "baseline",
        name: "Baseline",
        createdAt: 1,
      });

      const { Client } = await import("pg");
      const capabilityHolder = new Client({ connectionString: postgresUrl });
      const observer = new Client({ connectionString: postgresUrl });
      await capabilityHolder.connect();
      await observer.connect();
      const clock = vi.fn(() => 123);

      try {
        await capabilityHolder.query("begin");
        await capabilityHolder.query(
          'select "id" from "teams" where "id" = $1 for key share',
          ["baseline-team"],
        );
        const teardown = teardownTeamRows("baseline-team", clock);

        await vi.waitFor(
          async () => {
            const waiting = await observer.query<{ count: string }>(
              `select count(*)::text as count
                 from pg_stat_activity
                where pid <> pg_backend_pid()
                  and wait_event_type = 'Lock'
                  and query ilike '%from "teams"%for update%'`,
            );
            expect(Number(waiting.rows[0]?.count ?? 0)).toBeGreaterThan(0);
          },
          { timeout: 5_000, interval: 25 },
        );
        expect(clock).not.toHaveBeenCalled();

        await capabilityHolder.query("rollback");
        await expect(teardown).resolves.toEqual(["baseline-project"]);
        expect(clock).toHaveBeenCalledTimes(1);
        const [job] = await h.db.select().from(projectArtifactCleanupJobs);
        expect(job?.createdAt).toBe(123);
      } finally {
        await capabilityHolder.query("rollback").catch(() => undefined);
        await capabilityHolder.end();
        await observer.end();
      }
    });
  },
);
