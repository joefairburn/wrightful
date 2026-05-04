/**
 * `getActiveProject` is the public entry point that every RSC page hits to
 * get the project scoping for the current request. It reads `ctx.activeProject`
 * (populated upstream by `loadActiveProject` middleware), and only mints a
 * tenant scope when the field is present — null means "not authorised /
 * not resolved" and downstream pages must render their 404 shell.
 */
import { describe, it, expect, vi } from "vitest";

const { ctxRef, mockTenantScopeFromIds } = vi.hoisted(() => ({
  ctxRef: { current: {} as Record<string, unknown> },
  mockTenantScopeFromIds: vi.fn(
    (
      teamId: string,
      teamSlug: string,
      projectId: string,
      projectSlug: string,
    ) => ({
      teamId,
      teamSlug,
      projectId,
      projectSlug,
      db: { __mock: "kysely" },
      batch: async () => {},
    }),
  ),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("rwsdk/worker", () => ({
  requestInfo: {
    get ctx() {
      return ctxRef.current;
    },
  },
}));
vi.mock("@/tenant", () => ({
  tenantScopeFromIds: mockTenantScopeFromIds,
}));

import { getActiveProject } from "../lib/active-project";

describe("getActiveProject", () => {
  it("returns null when ctx.activeProject is unset", async () => {
    ctxRef.current = {};
    expect(await getActiveProject()).toBeNull();
    expect(mockTenantScopeFromIds).not.toHaveBeenCalled();
  });

  it("returns null when ctx.activeProject is explicitly null", async () => {
    ctxRef.current = { activeProject: null };
    expect(await getActiveProject()).toBeNull();
  });

  it("mints a TenantScope from the resolved IDs and exposes display fields", async () => {
    ctxRef.current = {
      activeProject: {
        id: "proj-1",
        teamId: "team-1",
        slug: "web",
        name: "Web",
        teamSlug: "acme",
        teamName: "Acme",
        role: "owner",
      },
    };

    const ap = await getActiveProject();
    expect(ap).not.toBeNull();
    expect(ap!.id).toBe("proj-1");
    expect(ap!.slug).toBe("web");
    expect(ap!.name).toBe("Web");
    expect(ap!.teamName).toBe("Acme");
    expect(ap!.teamSlug).toBe("acme");
    expect(ap!.projectId).toBe("proj-1");
    expect(ap!.projectSlug).toBe("web");

    expect(mockTenantScopeFromIds).toHaveBeenCalledWith(
      "team-1",
      "acme",
      "proj-1",
      "web",
    );
  });

  it("does NOT call tenantScopeFromIds when activeProject is null (no DO hop on unauth)", async () => {
    ctxRef.current = { activeProject: null };
    mockTenantScopeFromIds.mockClear();
    await getActiveProject();
    expect(mockTenantScopeFromIds).not.toHaveBeenCalled();
  });
});
