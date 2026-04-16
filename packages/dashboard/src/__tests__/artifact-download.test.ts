import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    R2_ACCOUNT_ID: "account-123",
    R2_BUCKET_NAME: "greenroom-artifacts",
    R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
    R2_SECRET_ACCESS_KEY: "secret-example",
    GREENROOM_PRESIGN_GET_TTL_SECONDS: "600",
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
    presignGet: vi.fn(
      async (_cfg: unknown, key: string, ttl: number) =>
        `https://r2.example/${encodeURIComponent(key)}?X-Amz-Expires=${ttl}&sig=get`,
    ),
  };
});

import { artifactDownloadHandler } from "../routes/api/artifact-download";
import { getDb } from "@/db";
import { presignGet } from "@/lib/r2-presign";

const mockedGetDb = vi.mocked(getDb);
const mockedPresignGet = vi.mocked(presignGet);

function mockDb(row: { r2Key: string } | null) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  const db = { select: vi.fn().mockReturnValue(chain) };
  mockedGetDb.mockReturnValue(db as never);
}

describe("artifactDownloadHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockEnv, {
      R2_ACCOUNT_ID: "account-123",
      R2_BUCKET_NAME: "greenroom-artifacts",
      R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
      R2_SECRET_ACCESS_KEY: "secret-example",
      GREENROOM_PRESIGN_GET_TTL_SECONDS: "600",
    });
  });

  it("404s when the artifact does not exist", async () => {
    mockDb(null);
    const res = await artifactDownloadHandler({ params: { id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("302s to a presigned R2 URL", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const res = await artifactDownloadHandler({ params: { id: "a-1" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("X-Amz-Expires=600");
    expect(mockedPresignGet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-123" }),
      "runs/r1/tr-1/a-1/trace.zip",
      600,
    );
  });

  it("500s clearly when R2 credentials are missing", async () => {
    mockEnv.R2_SECRET_ACCESS_KEY = "";
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const res = await artifactDownloadHandler({ params: { id: "a-1" } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("R2_SECRET_ACCESS_KEY");
  });
});
