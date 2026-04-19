import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth module
vi.mock("@/lib/auth", () => ({
  validateApiKey: vi.fn(),
}));

import { requireAuth, negotiateVersion } from "../routes/api/middleware";
import { validateApiKey } from "@/lib/auth";

const mockedValidateApiKey = vi.mocked(validateApiKey);

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/runs", {
    method: "POST",
    headers,
  });
}

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no auth header", async () => {
    mockedValidateApiKey.mockResolvedValue(null);

    const ctx = {} as any;
    const result = await (requireAuth as any)({
      request: makeRequest(),
      ctx,
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("returns 401 when key is invalid", async () => {
    mockedValidateApiKey.mockResolvedValue(null);

    const ctx = {} as any;
    const result = await (requireAuth as any)({
      request: makeRequest({ Authorization: "Bearer bad_key" }),
      ctx,
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });

  it("sets ctx.apiKey when valid (includes projectId for scoping)", async () => {
    const fakeKey = {
      id: "key-1",
      label: "test",
      projectId: "proj-abc",
    } as any;
    mockedValidateApiKey.mockResolvedValue(fakeKey);

    const ctx = {} as any;
    const result = await (requireAuth as any)({
      request: makeRequest({ Authorization: "Bearer wrf_valid" }),
      ctx,
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeUndefined(); // middleware passes through
    expect(ctx.apiKey).toEqual(fakeKey);
    expect(ctx.apiKey.projectId).toBe("proj-abc");
  });
});

describe("negotiateVersion", () => {
  it("passes through when no version header", () => {
    const result = (negotiateVersion as any)({
      request: makeRequest(),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeUndefined();
  });

  it("passes through for valid version 3", () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Wrightful-Version": "3" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeUndefined();
  });

  it("returns 400 for non-numeric version", () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Wrightful-Version": "abc" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(400);
  });

  it("returns 409 for v2 (now unsupported — CLI retired)", async () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Wrightful-Version": "2" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(409);
    const body = await result.json();
    expect(body.minimumVersion).toBe(3);
    expect(body.maximumVersion).toBe(3);
    expect(body.error).toContain("Client version too old");
  });

  it("returns 409 for version too new", async () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Wrightful-Version": "99" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(409);
    const body = await result.json();
    expect(body.error).toContain("Dashboard version too old");
  });
});
