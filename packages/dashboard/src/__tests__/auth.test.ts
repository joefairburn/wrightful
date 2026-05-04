import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({ getControlDb: vi.fn() }));

import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import { validateApiKey } from "../lib/auth";
import { getControlDb } from "@/control";

const mockedGetDb = vi.mocked(getControlDb);

let driver: ScriptedDriver;

beforeEach(() => {
  vi.clearAllMocks();
  const control = makeTestDb();
  driver = control.driver;
  mockedGetDb.mockReturnValue(control.db);
});

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function apiKeyRow(opts: {
  id?: string;
  keyHash: string;
  keyPrefix: string;
  revokedAt?: number | null;
}) {
  return {
    id: opts.id ?? "key-1",
    projectId: "proj-1",
    label: "test",
    keyHash: opts.keyHash,
    keyPrefix: opts.keyPrefix,
    createdAt: 1_700_000_000,
    lastUsedAt: null,
    revokedAt: opts.revokedAt ?? null,
  };
}

describe("validateApiKey", () => {
  it("returns null when authHeader is missing", async () => {
    expect(await validateApiKey(null)).toBeNull();
    // Never queried the DB.
    expect(driver.queries).toHaveLength(0);
  });

  it("returns null when authHeader is not a Bearer scheme", async () => {
    expect(await validateApiKey("Basic abc")).toBeNull();
    expect(await validateApiKey("xxx")).toBeNull();
    expect(driver.queries).toHaveLength(0);
  });

  it("accepts case-insensitive Bearer scheme", async () => {
    const rawKey = "wkXXXXXX_remainder";
    driver.results.push(
      selectResult([
        apiKeyRow({
          keyHash: await sha256Hex(rawKey),
          keyPrefix: rawKey.slice(0, 8),
        }),
      ]),
    );
    // The fire-and-forget lastUsedAt update also issues a query.
    driver.results.push(selectResult([]));

    const result = await validateApiKey(`bearer ${rawKey}`);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("key-1");
  });

  it("looks up rows by 8-character key prefix", async () => {
    const rawKey = "abcd1234_secret_part";
    driver.results.push(
      selectResult([
        apiKeyRow({
          keyHash: await sha256Hex(rawKey),
          keyPrefix: "abcd1234",
        }),
      ]),
    );
    driver.results.push(selectResult([]));

    await validateApiKey(`Bearer ${rawKey}`);
    const select = driver.queries.find((q) => q.sql.includes('from "apiKeys"'));
    expect(select).toBeDefined();
    expect(select?.parameters).toContain("abcd1234");
  });

  it("returns null when no row matches the prefix", async () => {
    driver.results.push(selectResult([]));
    expect(await validateApiKey("Bearer abcdefgh_unknown")).toBeNull();
  });

  it("returns null when prefix matches but hash does not (forged key)", async () => {
    const realKey = "abcd1234_real_secret";
    const forgedKey = "abcd1234_forged_secret";
    driver.results.push(
      selectResult([
        apiKeyRow({
          keyHash: await sha256Hex(realKey),
          keyPrefix: "abcd1234",
        }),
      ]),
    );
    expect(await validateApiKey(`Bearer ${forgedKey}`)).toBeNull();
  });

  it("returns null when the matching key is revoked", async () => {
    const rawKey = "revoked12_payload";
    driver.results.push(
      selectResult([
        apiKeyRow({
          keyHash: await sha256Hex(rawKey),
          keyPrefix: "revoked1",
          revokedAt: 1_700_000_500,
        }),
      ]),
    );
    expect(await validateApiKey(`Bearer ${rawKey}`)).toBeNull();
  });

  it("disambiguates two keys sharing the same 8-char prefix", async () => {
    const keyA = "abcd1234_alpha_payload";
    const keyB = "abcd1234_bravo_payload";
    driver.results.push(
      selectResult([
        apiKeyRow({
          id: "key-A",
          keyHash: await sha256Hex(keyA),
          keyPrefix: "abcd1234",
        }),
        apiKeyRow({
          id: "key-B",
          keyHash: await sha256Hex(keyB),
          keyPrefix: "abcd1234",
        }),
      ]),
    );
    driver.results.push(selectResult([]));

    const result = await validateApiKey(`Bearer ${keyB}`);
    expect(result?.id).toBe("key-B");
  });

  it("uses constant-time comparison: presence of the prefix-row alone does not authenticate", async () => {
    // Same prefix, different hash → must reject. Guards against an
    // accidental short-circuit that returned the prefix match directly.
    driver.results.push(
      selectResult([
        apiKeyRow({
          keyHash: await sha256Hex("OTHER_KEY"),
          keyPrefix: "samepref",
        }),
      ]),
    );
    expect(await validateApiKey("Bearer samepref_attacker")).toBeNull();
  });

  it("issues an UPDATE to lastUsedAt on successful auth", async () => {
    const rawKey = "uselast1_secret";
    driver.results.push(
      selectResult([
        apiKeyRow({
          keyHash: await sha256Hex(rawKey),
          keyPrefix: "uselast1",
        }),
      ]),
    );
    driver.results.push(selectResult([]));

    await validateApiKey(`Bearer ${rawKey}`);
    // Allow the fire-and-forget update to schedule.
    await new Promise((r) => setTimeout(r, 0));

    const update = driver.queries.find((q) => q.sql.startsWith("update"));
    expect(update).toBeDefined();
    expect(update?.sql).toMatch(/"lastUsedAt"/);
  });
});
