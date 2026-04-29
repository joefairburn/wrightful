import { describe, it, expect, vi, beforeEach } from "vitest";

type TenantStub = {
  sweepStuckRuns: ReturnType<typeof vi.fn>;
};

const { mockEnv, tenantStubs } = vi.hoisted(() => {
  const stubs = new Map<string, TenantStub>();
  return {
    mockEnv: {
      TENANT: {
        idFromName: (name: string) => name,
        get: (id: unknown) => stubs.get(id as string),
      },
    } as Record<string, unknown>,
    tenantStubs: stubs,
  };
});

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/control", () => ({ getControlDb: vi.fn() }));
// Prevent the transitive `rwsdk/db` import (which ESM-fails in Node) from
// loading. Tests exercise the fan-out by scripting stubs into
// `tenantStubs` and overriding the internal accessor.
vi.mock("@/tenant/internal", () => ({
  internalTenantStubForCron: (teamId: string) => tenantStubs.get(teamId),
}));

import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import { sweepStuckRuns } from "../scheduled";
import { getControlDb } from "@/control";

const mockedGetDb = vi.mocked(getControlDb);

let controlDriver: ScriptedDriver;

function setupActiveTeams(teamIds: string[]) {
  const control = makeTestDb();
  controlDriver = control.driver;
  controlDriver.results.push(selectResult(teamIds.map((id) => ({ id }))));
  mockedGetDb.mockReturnValue(control.db);
}

function setTenantSweep(
  teamId: string,
  rows: Array<{ id: string; createdAt: number }>,
) {
  const stub: TenantStub = {
    sweepStuckRuns: vi.fn().mockResolvedValue(rows),
  };
  tenantStubs.set(teamId, stub);
  return stub;
}

describe("sweepStuckRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantStubs.clear();
    for (const k of Object.keys(mockEnv)) {
      if (k !== "TENANT") delete mockEnv[k];
    }
  });

  it("fans out to active teams only and aggregates swept counts", async () => {
    setupActiveTeams(["team-a", "team-b"]);
    setTenantSweep("team-a", [
      { id: "run-1", createdAt: 1_000 },
      { id: "run-2", createdAt: 1_100 },
    ]);
    setTenantSweep("team-b", [{ id: "run-3", createdAt: 1_200 }]);

    const now = new Date("2026-04-19T12:00:00Z");
    const count = await sweepStuckRuns(now);

    expect(count).toBe(3);
    expect(tenantStubs.get("team-a")!.sweepStuckRuns).toHaveBeenCalledTimes(1);
    expect(tenantStubs.get("team-b")!.sweepStuckRuns).toHaveBeenCalledTimes(1);

    // Default stale = 30 min → cutoff = now - 30*60s.
    const expectedCutoff = Math.floor(now.getTime() / 1000) - 30 * 60;
    const expectedNow = Math.floor(now.getTime() / 1000);
    expect(tenantStubs.get("team-a")!.sweepStuckRuns).toHaveBeenCalledWith(
      expectedCutoff,
      expectedNow,
    );
  });

  it("returns 0 when no teams have recent activity", async () => {
    setupActiveTeams([]);
    const count = await sweepStuckRuns();
    expect(count).toBe(0);
  });

  it("honors WRIGHTFUL_RUN_STALE_MINUTES env override", async () => {
    mockEnv.WRIGHTFUL_RUN_STALE_MINUTES = "5";
    setupActiveTeams(["team-a"]);
    setTenantSweep("team-a", []);

    const now = new Date("2026-04-19T12:00:00Z");
    await sweepStuckRuns(now);

    // Control-DB query must filter teams against a 5-minute cutoff.
    const teamsQuery = controlDriver.queries[0];
    expect(teamsQuery.sql).toMatch(/"lastActivityAt"\s*>=\s*\?/);
    const expectedCutoff = Math.floor(now.getTime() / 1000) - 5 * 60;
    expect(teamsQuery.parameters).toContain(expectedCutoff);
    expect(tenantStubs.get("team-a")!.sweepStuckRuns).toHaveBeenCalledWith(
      expectedCutoff,
      Math.floor(now.getTime() / 1000),
    );
  });

  it("falls back to default when env is non-numeric", async () => {
    mockEnv.WRIGHTFUL_RUN_STALE_MINUTES = "not-a-number";
    setupActiveTeams([]);
    await expect(sweepStuckRuns()).resolves.toBe(0);
  });

  it("continues sweeping other teams when one DO call throws", async () => {
    setupActiveTeams(["team-a", "team-b"]);
    const a = setTenantSweep("team-a", []);
    a.sweepStuckRuns.mockRejectedValueOnce(new Error("DO unreachable"));
    setTenantSweep("team-b", [{ id: "run-3", createdAt: 1_200 }]);

    const count = await sweepStuckRuns();
    expect(count).toBe(1);
  });
});
