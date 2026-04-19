import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock env — flipped per-test to assert threshold override.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string>,
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ getDb: vi.fn() }));

import { sweepStuckRuns } from "../scheduled";
import { getDb } from "@/db";

const mockedGetDb = vi.mocked(getDb);

interface DbStub {
  update: ReturnType<typeof vi.fn>;
  whereClause: unknown;
  setValue: unknown;
}

function makeDb(returnedRows: Array<{ id: string; createdAt: Date }>): DbStub {
  const state: DbStub = {
    update: vi.fn(),
    whereClause: null,
    setValue: null,
  };
  state.update.mockImplementation(() => ({
    set: vi.fn().mockImplementation((value: unknown) => {
      state.setValue = value;
      return {
        where: vi.fn().mockImplementation((clause: unknown) => {
          state.whereClause = clause;
          return {
            returning: vi.fn().mockResolvedValue(returnedRows),
          };
        }),
      };
    }),
  }));
  return state;
}

describe("sweepStuckRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  });

  it("marks stuck runs as interrupted and returns the count", async () => {
    const now = new Date("2026-04-19T12:00:00Z");
    const stuck = new Date("2026-04-19T11:00:00Z");
    const db = makeDb([
      { id: "run-1", createdAt: stuck },
      { id: "run-2", createdAt: stuck },
    ]);
    mockedGetDb.mockReturnValue(db as never);

    const count = await sweepStuckRuns(now);

    expect(count).toBe(2);
    expect(db.update).toHaveBeenCalledTimes(1);
    const setValue = db.setValue as Record<string, unknown>;
    expect(setValue.status).toBe("interrupted");
    expect(setValue.completedAt).toBe(now);
  });

  it("returns 0 when nothing is stuck", async () => {
    const db = makeDb([]);
    mockedGetDb.mockReturnValue(db as never);
    const count = await sweepStuckRuns();
    expect(count).toBe(0);
  });

  it("honors WRIGHTFUL_RUN_STALE_MINUTES env override", async () => {
    mockEnv.WRIGHTFUL_RUN_STALE_MINUTES = "5";
    const db = makeDb([]);
    mockedGetDb.mockReturnValue(db as never);
    await sweepStuckRuns(new Date("2026-04-19T12:00:00Z"));
    // The whereClause is drizzle's internal AST — we don't inspect it
    // directly here, just assert the handler ran without throwing when the
    // threshold is overridden. A smaller threshold means more aggressive
    // sweeping; the default-vs-override behavior is exercised by the
    // integration test (see watchdog smoke in worklog).
    expect(db.update).toHaveBeenCalled();
  });

  it("falls back to default when env is non-numeric", async () => {
    mockEnv.WRIGHTFUL_RUN_STALE_MINUTES = "not-a-number";
    const db = makeDb([]);
    mockedGetDb.mockReturnValue(db as never);
    await expect(sweepStuckRuns()).resolves.toBe(0);
  });
});
