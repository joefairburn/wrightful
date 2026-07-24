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
vi.mock("void/storage", () => ({
  storage: {
    put: () => Promise.resolve(),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    delete: () => Promise.resolve(),
  },
}));

const { resetTables } = await import("./harness");
const { registerArtifacts } = await import("@/lib/artifacts/store");
const { makeTenantScope } = await import("@/lib/scope");
const { artifacts, projects, runs, teams, testResults } =
  await import("../../../db/schema");

afterAll(async () => {
  await h.client.close();
});

const postgresUrl = process.env.PG_TEST_URL;

describe.skipIf(!postgresUrl)(
  "direct artifact capability vs teardown (real Postgres)",
  () => {
    it("holds the project key-share lock until the presigned PUT is minted", async () => {
      await resetTables(h.client, [
        teams,
        projects,
        runs,
        testResults,
        artifacts,
      ]);
      await h.db.insert(teams).values({
        id: "artifact-team",
        slug: "artifact",
        name: "Artifact",
        tier: "free",
        createdAt: 1,
      });
      await h.db.insert(projects).values({
        id: "artifact-project",
        teamId: "artifact-team",
        slug: "artifact",
        name: "Artifact",
        createdAt: 1,
      });
      await h.db.insert(runs).values({
        id: "artifact-run",
        teamId: "artifact-team",
        projectId: "artifact-project",
        totalTests: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 1,
        status: "running",
        origin: "ci",
        createdAt: 1,
        lastActivityAt: 1,
      });
      await h.db.insert(testResults).values({
        id: "artifact-result",
        projectId: "artifact-project",
        runId: "artifact-run",
        testId: "test",
        title: "test",
        file: "test.ts",
        status: "passed",
        durationMs: 1,
        retryCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await h.db.insert(artifacts).values({
        id: "artifact-existing",
        projectId: "artifact-project",
        testResultId: "artifact-result",
        type: "screenshot",
        name: "shot.png",
        contentType: "image/png",
        sizeBytes: 100,
        r2Key: "t/artifact-team/p/artifact-project/shot.png",
        attempt: 0,
        createdAt: 1,
      });

      const signer = Promise.withResolvers<string>();
      const signStarted = Promise.withResolvers<void>();
      const registration = registerArtifacts(
        makeTenantScope({
          teamId: "artifact-team",
          projectId: "artifact-project",
          teamSlug: "artifact",
          projectSlug: "artifact",
        }),
        {
          runId: "artifact-run",
          artifacts: [
            {
              testResultId: "artifact-result",
              type: "screenshot",
              name: "shot.png",
              contentType: "image/png",
              sizeBytes: 100,
              attempt: 0,
            },
          ],
        },
        1_000,
        1,
        () => {
          signStarted.resolve();
          return signer.promise;
        },
      );
      await signStarted.promise;

      const { Client } = await import("pg");
      const teardown = new Client({ connectionString: postgresUrl });
      await teardown.connect();
      try {
        await teardown.query("begin");
        const blocked = await teardown
          .query(
            'select "id" from "projects" where "id" = $1 for update nowait',
            ["artifact-project"],
          )
          .then(
            () => null,
            (error: unknown) => error as { code?: string },
          );
        expect(blocked?.code).toBe("55P03");
      } finally {
        await teardown.query("rollback").catch(() => undefined);
        await teardown.end();
      }

      signer.resolve("https://r2.example/presigned-put");
      await expect(registration).resolves.toEqual({
        kind: "ok",
        uploads: [
          {
            artifactId: "artifact-existing",
            r2Key: "t/artifact-team/p/artifact-project/shot.png",
            uploadUrl: "https://r2.example/presigned-put",
          },
        ],
      });
    });
  },
);
