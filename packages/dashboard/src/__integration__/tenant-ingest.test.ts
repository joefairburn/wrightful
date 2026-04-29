import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ulid } from "ulid";
import {
  appendResultsHandler,
  completeRunHandler,
  openRunHandler,
} from "@/routes/api/runs";
import {
  composeRunProgress,
  runRoomId,
  type RunProgress,
} from "@/routes/api/progress";
import { tenantScopeForApiKey } from "@/tenant";
import { getTenantDb } from "@/tenant/internal";
import { seedTeamAndProject } from "./helpers/tenant";
// Workers RPC always wraps stub method calls in Promises at runtime.
// Typed separately here so `await stub.getState(...)` satisfies oxlint's
// await-thenable rule (the real SyncedStateServer class declares getState
// as synchronous, but the stub invocation is always async over the wire).
interface SyncedStateDOStub {
  getState(key: string): Promise<unknown>;
}
interface TestEnvWithRealtime {
  SYNCED_STATE_SERVER: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): SyncedStateDOStub;
  };
}
const testEnvRt = env as unknown as TestEnvWithRealtime;

/**
 * End-to-end ingest flow against the real ControlDO + real tenant DO. No
 * mocks. Mirrors what a reporter does: opens a run, appends results in a
 * batch, marks it complete. Asserts the resulting aggregates + test list
 * match.
 */

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`https://example.com${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("streaming ingest → composeRunProgress", () => {
  it("persists a full run across open / append / complete and reads back aggregates", async () => {
    const { projectId, teamId } = await seedTeamAndProject();
    const authCtx = {
      apiKey: { id: ulid(), label: "test", projectId },
    };

    // 1. openRun — reporter announces the run with a planned test list.
    const open = await openRunHandler({
      request: jsonRequest("/api/runs", {
        idempotencyKey: `ci-${ulid()}`,
        run: {
          reporterVersion: "0.1.0",
          playwrightVersion: "1.59.1",
          branch: "main",
          expectedTotalTests: 2,
          plannedTests: [
            {
              testId: "a.spec.ts|passing",
              title: "passing",
              file: "a.spec.ts",
            },
            {
              testId: "a.spec.ts|failing",
              title: "failing",
              file: "a.spec.ts",
            },
          ],
        },
      }),
      ctx: authCtx,
    });
    expect(open.status).toBe(201);
    const openBody = (await open.json()) as { runId: string; runUrl: string };
    const runId = openBody.runId;
    expect(runId).toMatch(/^[0-9A-Z]{26}$/);

    // 2. appendResults — one passing test, one failing test. Each carries
    //    attempt rows; the failing test has two attempts.
    const append = await appendResultsHandler({
      request: jsonRequest(`/api/runs/${runId}/results`, {
        results: [
          {
            clientKey: "k-pass",
            testId: "a.spec.ts|passing",
            title: "passing",
            file: "a.spec.ts",
            status: "passed",
            durationMs: 12,
            retryCount: 0,
            tags: ["smoke"],
            annotations: [],
            attempts: [
              {
                attempt: 0,
                status: "passed",
                durationMs: 12,
                errorMessage: null,
                errorStack: null,
              },
            ],
          },
          {
            clientKey: "k-fail",
            testId: "a.spec.ts|failing",
            title: "failing",
            file: "a.spec.ts",
            status: "failed",
            durationMs: 40,
            retryCount: 1,
            // Top-level error mirrors the last attempt's error — this is
            // what the reporter sends and what aggregate views render.
            errorMessage: "still oops",
            errorStack: null,
            tags: [],
            annotations: [{ type: "issue", description: "bug-123" }],
            attempts: [
              {
                attempt: 0,
                status: "failed",
                durationMs: 20,
                errorMessage: "oops",
                errorStack: null,
              },
              {
                attempt: 1,
                status: "failed",
                durationMs: 20,
                errorMessage: "still oops",
                errorStack: null,
              },
            ],
          },
        ],
      }),
      params: { id: runId },
      ctx: authCtx,
    });
    expect(append.status).toBe(200);
    const appendBody = (await append.json()) as {
      results: Array<{ clientKey: string; testResultId: string }>;
    };
    expect(appendBody.results).toHaveLength(2);
    const mapping = new Map(
      appendBody.results.map((r) => [r.clientKey, r.testResultId]),
    );
    expect(mapping.get("k-pass")).toMatch(/^[0-9A-Z]{26}$/);

    // 3. completeRun — reporter announces the terminal outcome.
    const complete = await completeRunHandler({
      request: jsonRequest(`/api/runs/${runId}/complete`, {
        status: "failed",
        durationMs: 1234,
      }),
      params: { id: runId },
      ctx: authCtx,
    });
    expect(complete.status).toBe(200);

    // 4. Read back via composeRunProgress — the same path RSC pages use
    //    for SSR seed state and for broadcast fan-out.
    const scope = await tenantScopeForApiKey(authCtx.apiKey);
    expect(scope).not.toBeNull();
    const progress = await composeRunProgress(scope!, runId);
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe("failed");
    expect(progress!.counts).toMatchObject({
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 0,
    });
    expect(progress!.tests).toHaveLength(2);
    const byTestId = new Map(progress!.tests.map((t) => [t.testId, t]));
    expect(byTestId.get("a.spec.ts|passing")?.status).toBe("passed");
    expect(byTestId.get("a.spec.ts|failing")?.status).toBe("failed");
    expect(byTestId.get("a.spec.ts|failing")?.errorMessage).toBe("still oops");

    // 5. Verify broadcastRunProgress reached the realtime DO. The ingest
    //    handlers call broadcastRunProgress after every write; after
    //    completeRun the "progress" key should hold the terminal state.
    const ns = testEnvRt.SYNCED_STATE_SERVER;
    const roomId = runRoomId({
      teamSlug: scope!.teamSlug,
      projectSlug: scope!.projectSlug,
      runId,
    });
    const realtimeStub = ns.get(ns.idFromName(roomId));
    const broadcastedState = (await realtimeStub.getState("progress")) as
      | RunProgress
      | undefined;
    expect(broadcastedState).not.toBeNull();
    expect(broadcastedState?.status).toBe("failed");
    expect(broadcastedState?.counts.passed).toBe(1);
    expect(broadcastedState?.counts.failed).toBe(1);

    // 6. Spot-check persisted side-effects beyond the progress composite:
    //    tags + annotations + attempts were written correctly.
    const tenantDb = getTenantDb(teamId);

    const tags = await tenantDb
      .selectFrom("testTags")
      .select("tag")
      .where("testResultId", "=", byTestId.get("a.spec.ts|passing")!.id)
      .execute();
    expect(tags.map((t) => t.tag)).toEqual(["smoke"]);

    const annotations = await tenantDb
      .selectFrom("testAnnotations")
      .select(["type", "description"])
      .where("testResultId", "=", byTestId.get("a.spec.ts|failing")!.id)
      .execute();
    expect(annotations).toEqual([{ type: "issue", description: "bug-123" }]);

    const attempts = await tenantDb
      .selectFrom("testResultAttempts")
      .select(["attempt", "status"])
      .where("testResultId", "=", byTestId.get("a.spec.ts|failing")!.id)
      .orderBy("attempt", "asc")
      .execute();
    expect(attempts).toEqual([
      { attempt: 0, status: "failed" },
      { attempt: 1, status: "failed" },
    ]);
  });

  it("returns the existing runId on an idempotency-key replay", async () => {
    const { projectId } = await seedTeamAndProject();
    const authCtx = {
      apiKey: { id: ulid(), label: "test", projectId },
    };
    const idempotencyKey = `ci-${ulid()}`;

    const first = await openRunHandler({
      request: jsonRequest("/api/runs", {
        idempotencyKey,
        run: { branch: "main", plannedTests: [] },
      }),
      ctx: authCtx,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { runId: string };

    const second = await openRunHandler({
      request: jsonRequest("/api/runs", {
        idempotencyKey,
        run: { branch: "main", plannedTests: [] },
      }),
      ctx: authCtx,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      runId: string;
      duplicate: boolean;
    };
    expect(secondBody.runId).toBe(firstBody.runId);
    expect(secondBody.duplicate).toBe(true);
  });
});
