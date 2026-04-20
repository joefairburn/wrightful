import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared holder populated via `vi.hoisted` so the vi.mock factory (which is
// itself hoisted to the top of the module) can safely read it.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    WRIGHTFUL_MAX_ARTIFACT_BYTES: "52428800",
  } as Record<string, string>,
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

vi.mock("@/db", () => ({ getDb: vi.fn() }));

import { registerHandler } from "../routes/api/artifacts";
import { getDb } from "@/db";

const mockedGetDb = vi.mocked(getDb);

function makeRequest(body: unknown): Request {
  return new Request("https://example.com/api/artifacts/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AUTH_CTX = {
  apiKey: { id: "key-1", label: "test", projectId: "proj-1" },
};

interface DbMock {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  inserted: unknown[] | null;
}

// Register handler runs two selects: (1) run ownership by (runId, projectId),
// (2) testResultId membership in that run. The mock returns those in order.
function makeDbMock(opts: {
  runOwned?: boolean;
  validTestResultIds?: string[];
}): DbMock {
  const runOwned = opts.runOwned ?? true;
  const validTestResultIds = opts.validTestResultIds ?? [];

  const selectResults = [
    runOwned ? [{ id: "run-1" }] : [],
    validTestResultIds.map((id) => ({ id })),
  ];

  const select = vi.fn().mockImplementation(() => {
    const result = selectResults.shift() ?? [];
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
        then: (resolve: (v: unknown) => void) => resolve(result),
      }),
    };
  });

  const state: DbMock = { select, insert: vi.fn(), inserted: null };
  state.insert.mockImplementation(() => ({
    values: vi.fn().mockImplementation((rows: unknown[]) => {
      state.inserted = rows;
      return Promise.resolve();
    }),
  }));
  return state;
}

describe("registerHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockEnv, {
      WRIGHTFUL_MAX_ARTIFACT_BYTES: "52428800",
    });
  });

  it("401s when no API key is on the context", async () => {
    mockedGetDb.mockReturnValue({} as never);
    const res = await registerHandler({
      request: makeRequest({ runId: "run-1", artifacts: [] }),
      ctx: {},
    });
    expect(res.status).toBe(401);
  });

  it("400s on invalid payload", async () => {
    mockedGetDb.mockReturnValue({} as never);
    const res = await registerHandler({
      request: makeRequest({ runId: "", artifacts: [] }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("413s when an artifact exceeds the size cap", async () => {
    mockEnv.WRIGHTFUL_MAX_ARTIFACT_BYTES = "1024";
    const db = makeDbMock({});
    mockedGetDb.mockReturnValue(db as never);

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 5000,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { maxBytes: number };
    expect(body.maxBytes).toBe(1024);
  });

  it("404s when the run doesn't belong to the caller's project", async () => {
    const db = makeDbMock({ runOwned: false });
    mockedGetDb.mockReturnValue(db as never);

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 1024,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("400s when a testResultId doesn't belong to the run", async () => {
    // db returns only "tr-ok"; we'll ask about "tr-ok" and "tr-bad"
    const db = makeDbMock({ validTestResultIds: ["tr-ok"] });
    mockedGetDb.mockReturnValue(db as never);

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-ok",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 1024,
          },
          {
            testResultId: "tr-bad",
            type: "screenshot",
            name: "s.png",
            contentType: "image/png",
            sizeBytes: 1024,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { unknownTestResultIds: string[] };
    expect(body.unknownTestResultIds).toEqual(["tr-bad"]);
  });

  it("returns 201 with upload URLs and eagerly inserts artifact rows", async () => {
    const db = makeDbMock({ validTestResultIds: ["tr-1"] });
    mockedGetDb.mockReturnValue(db as never);

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 1024,
            attempt: 2,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      uploads: Array<{ artifactId: string; uploadUrl: string; r2Key: string }>;
    };
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0].r2Key).toMatch(
      /^runs\/run-1\/tr-1\/[0-9A-Z]+\/trace\.zip$/,
    );
    expect(body.uploads[0].uploadUrl).toBe(
      `/api/artifacts/${body.uploads[0].artifactId}/upload`,
    );

    expect(db.inserted).toBeTruthy();
    const rows = db.inserted as Array<{
      r2Key: string;
      testResultId: string;
      attempt: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].testResultId).toBe("tr-1");
    expect(rows[0].attempt).toBe(2);
  });
});
