import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared holder populated via `vi.hoisted` so the vi.mock factory (which is
// itself hoisted to the top of the module) can safely read it.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    R2_ACCOUNT_ID: "account-123",
    R2_BUCKET_NAME: "greenroom-artifacts",
    R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
    R2_SECRET_ACCESS_KEY: "secret-example",
    GREENROOM_MAX_ARTIFACT_BYTES: "52428800",
    GREENROOM_PRESIGN_PUT_TTL_SECONDS: "900",
  } as Record<string, string>,
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

vi.mock("@/db", () => ({ getDb: vi.fn() }));

vi.mock("@/lib/r2-presign", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/r2-presign")>(
      "@/lib/r2-presign",
    );
  return {
    ...actual,
    presignPut: vi.fn(
      async (_cfg: unknown, key: string, expiresSeconds: number) =>
        `https://account-123.r2.cloudflarestorage.com/greenroom-artifacts/${encodeURIComponent(key)}?X-Amz-Expires=${expiresSeconds}&X-Amz-Signature=fake`,
    ),
  };
});

import { presignHandler } from "../routes/api/artifacts";
import { getDb } from "@/db";
import { presignPut } from "@/lib/r2-presign";

const mockedGetDb = vi.mocked(getDb);
const mockedPresignPut = vi.mocked(presignPut);

function makeRequest(body: unknown): Request {
  return new Request("https://example.com/api/artifacts/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface DbMock {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  inserted: unknown[] | null;
}

function makeDbMock(validTestResultIds: string[]): DbMock {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(validTestResultIds.map((id) => ({ id }))),
  };
  const state: DbMock = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn(),
    inserted: null,
  };
  state.insert.mockImplementation(() => ({
    values: vi.fn().mockImplementation((rows: unknown[]) => {
      state.inserted = rows;
      return Promise.resolve();
    }),
  }));
  return state;
}

describe("presignHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset env mutations
    Object.assign(mockEnv, {
      R2_ACCOUNT_ID: "account-123",
      R2_BUCKET_NAME: "greenroom-artifacts",
      R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
      R2_SECRET_ACCESS_KEY: "secret-example",
      GREENROOM_MAX_ARTIFACT_BYTES: "52428800",
      GREENROOM_PRESIGN_PUT_TTL_SECONDS: "900",
    });
  });

  it("400s on invalid payload", async () => {
    mockedGetDb.mockReturnValue({} as never);
    const res = await presignHandler({
      request: makeRequest({ runId: "", artifacts: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("413s when an artifact exceeds the size cap", async () => {
    mockEnv.GREENROOM_MAX_ARTIFACT_BYTES = "1024";
    const db = makeDbMock([]);
    mockedGetDb.mockReturnValue(db as never);

    const res = await presignHandler({
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
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { maxBytes: number };
    expect(body.maxBytes).toBe(1024);
  });

  it("500s with clear error when R2 creds are missing", async () => {
    mockEnv.R2_ACCESS_KEY_ID = "";
    const db = makeDbMock(["tr-1"]);
    mockedGetDb.mockReturnValue(db as never);

    const res = await presignHandler({
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
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("R2_ACCESS_KEY_ID");
  });

  it("400s when a testResultId doesn't belong to the run", async () => {
    // db returns only "tr-ok"; we'll ask about "tr-ok" and "tr-bad"
    const db = makeDbMock(["tr-ok"]);
    mockedGetDb.mockReturnValue(db as never);

    const res = await presignHandler({
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
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { unknownTestResultIds: string[] };
    expect(body.unknownTestResultIds).toEqual(["tr-bad"]);
  });

  it("returns 201 with signed URLs and eagerly inserts artifact rows", async () => {
    const db = makeDbMock(["tr-1"]);
    mockedGetDb.mockReturnValue(db as never);

    const res = await presignHandler({
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
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      uploads: Array<{ artifactId: string; url: string; r2Key: string }>;
    };
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0].r2Key).toMatch(
      /^runs\/run-1\/tr-1\/[0-9A-Z]+\/trace\.zip$/,
    );
    expect(body.uploads[0].url).toContain("X-Amz-Signature=fake");

    expect(mockedPresignPut).toHaveBeenCalledTimes(1);
    expect(mockedPresignPut).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-123" }),
      expect.stringMatching(/^runs\/run-1\/tr-1\//),
      900,
    );

    expect(db.inserted).toBeTruthy();
    const rows = db.inserted as Array<{ r2Key: string; testResultId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].testResultId).toBe("tr-1");
  });
});
