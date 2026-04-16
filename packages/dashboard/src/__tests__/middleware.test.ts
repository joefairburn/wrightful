import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth module
vi.mock("@/lib/auth", () => ({
  validateApiKey: vi.fn(),
}));

import { requireAuth, negotiateVersion } from "../routes/api/middleware";
import { validateApiKey } from "@/lib/auth";

const mockedValidateApiKey = vi.mocked(validateApiKey);

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/ingest", {
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

  it("sets ctx.apiKey when valid", async () => {
    const fakeKey = { id: "key-1", label: "test" } as any;
    mockedValidateApiKey.mockResolvedValue(fakeKey);

    const ctx = {} as any;
    const result = await (requireAuth as any)({
      request: makeRequest({ Authorization: "Bearer grn_valid" }),
      ctx,
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeUndefined(); // middleware passes through
    expect(ctx.apiKey).toEqual(fakeKey);
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

  it("passes through for valid version 1", () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Greenroom-Version": "1" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeUndefined();
  });

  it("passes through for valid version 2", () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Greenroom-Version": "2" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeUndefined();
  });

  it("returns 400 for non-numeric version", () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Greenroom-Version": "abc" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(400);
  });

  it("returns 409 for version too old", async () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Greenroom-Version": "0" }),
      ctx: {},
      rw: { nonce: "" },
      response: { headers: new Headers() },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(409);
    const body = await result.json();
    expect(body.minimumVersion).toBe(1);
    expect(body.maximumVersion).toBe(2);
    expect(body.error).toContain("CLI version too old");
  });

  it("returns 409 for version too new", async () => {
    const result = (negotiateVersion as any)({
      request: makeRequest({ "X-Greenroom-Version": "99" }),
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
