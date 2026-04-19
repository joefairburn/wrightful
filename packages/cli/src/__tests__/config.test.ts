import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cosmiconfig before importing config module
vi.mock("cosmiconfig", () => ({
  cosmiconfig: () => ({
    search: vi.fn().mockResolvedValue(null),
  }),
}));

import { resolveConfig } from "../lib/config.js";

describe("resolveConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves config from CLI flags", async () => {
    const config = await resolveConfig({
      url: "https://dash.example.com",
      token: "wrf_abc123",
      artifacts: "all",
    });

    expect(config.url).toBe("https://dash.example.com");
    expect(config.token).toBe("wrf_abc123");
    expect(config.artifacts).toBe("all");
  });

  it("falls back to env vars when no CLI flags", async () => {
    vi.stubEnv("WRIGHTFUL_URL", "https://env.example.com");
    vi.stubEnv("WRIGHTFUL_API_KEY", "wrf_env_key");

    const config = await resolveConfig({});
    expect(config.url).toBe("https://env.example.com");
    expect(config.token).toBe("wrf_env_key");
  });

  it("CLI flags override env vars", async () => {
    vi.stubEnv("WRIGHTFUL_URL", "https://env.example.com");
    vi.stubEnv("WRIGHTFUL_API_KEY", "wrf_env_key");

    const config = await resolveConfig({
      url: "https://cli.example.com",
      token: "wrf_cli_key",
    });
    expect(config.url).toBe("https://cli.example.com");
    expect(config.token).toBe("wrf_cli_key");
  });

  it("defaults artifacts to 'failed'", async () => {
    const config = await resolveConfig({
      url: "https://dash.example.com",
      token: "wrf_key",
    });
    expect(config.artifacts).toBe("failed");
  });

  it("throws when URL is missing", async () => {
    await expect(resolveConfig({ token: "wrf_key" })).rejects.toThrow(
      "Missing required config",
    );
  });

  it("throws when token is missing", async () => {
    await expect(
      resolveConfig({ url: "https://dash.example.com" }),
    ).rejects.toThrow("Missing required config");
  });

  it("throws when URL is invalid", async () => {
    await expect(
      resolveConfig({ url: "not-a-url", token: "wrf_key" }),
    ).rejects.toThrow();
  });

  it("rejects non-HTTPS dashboard URLs", async () => {
    await expect(
      resolveConfig({ url: "http://evil.example.com", token: "wrf_key" }),
    ).rejects.toThrow(/https/);
  });

  it("accepts http:// for localhost", async () => {
    const config = await resolveConfig({
      url: "http://localhost:5173",
      token: "wrf_key",
    });
    expect(config.url).toBe("http://localhost:5173");
  });

  it("accepts http:// for 127.0.0.1", async () => {
    const config = await resolveConfig({
      url: "http://127.0.0.1:5173",
      token: "wrf_key",
    });
    expect(config.url).toBe("http://127.0.0.1:5173");
  });
});
