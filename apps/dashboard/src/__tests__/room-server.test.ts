import { describe, it, expect } from "vite-plus/test";
import {
  INTERNAL_HEADER,
  ROOM_CONNECTION_CAP,
  isInternalRequest,
  resolveInternalSecret,
  roomAtCapacity,
} from "@/realtime/room-server";

/**
 * Pure server-side room guards behind the `void/ws` rooms: the internal-publish
 * secret (resolution + constant-time check) and the per-room connection cap.
 * These are the tenant-isolation + abuse backstops on the broadcast path, so
 * they're pinned here without a live socket.
 */

describe("resolveInternalSecret", () => {
  it("uses an explicit REALTIME_INTERNAL_SECRET override", () => {
    expect(
      resolveInternalSecret({ REALTIME_INTERNAL_SECRET: "dedicated" }),
    ).toBe("dedicated");
  });

  it("honors an explicit empty override (presence, not truthiness)", () => {
    expect(resolveInternalSecret({ REALTIME_INTERNAL_SECRET: "" })).toBe("");
  });

  it("THROWS when no override and no build-time secret are available (never the auth secret)", () => {
    // Under test the `__WRIGHTFUL_INTERNAL_SECRET__` define is omitted, so with
    // no env override there is genuinely no internal secret — it must fail loud,
    // never silently borrow BETTER_AUTH_SECRET.
    expect(() => resolveInternalSecret({})).toThrow(
      /internal secret unavailable/i,
    );
    expect(() =>
      resolveInternalSecret({ REALTIME_INTERNAL_SECRET: undefined }),
    ).toThrow();
  });
});

describe("isInternalRequest", () => {
  const SECRET = "s3cr3t-internal-value-of-some-length";
  const reqWith = (header: string | null): Request =>
    new Request("https://void.local/ws/run/r1", {
      method: "POST",
      headers: header === null ? {} : { [INTERNAL_HEADER]: header },
    });

  it("accepts a request whose header equals the secret", () => {
    expect(isInternalRequest(reqWith(SECRET), SECRET)).toBe(true);
  });

  it("rejects a wrong value of equal length", () => {
    const wrong = "S" + SECRET.slice(1); // same length, different first byte
    expect(wrong.length).toBe(SECRET.length);
    expect(isInternalRequest(reqWith(wrong), SECRET)).toBe(false);
  });

  it("rejects a value of different length (length-mismatch short-circuit)", () => {
    expect(isInternalRequest(reqWith(SECRET + "x"), SECRET)).toBe(false);
    expect(isInternalRequest(reqWith(SECRET.slice(0, -1)), SECRET)).toBe(false);
  });

  it("rejects a request with no internal header", () => {
    expect(isInternalRequest(reqWith(null), SECRET)).toBe(false);
  });
});

describe("roomAtCapacity", () => {
  const conns = (n: number): unknown[] => Array.from({ length: n }, () => ({}));

  it("is false below the cap", () => {
    expect(roomAtCapacity(conns(0))).toBe(false);
    expect(roomAtCapacity(conns(ROOM_CONNECTION_CAP - 1))).toBe(false);
  });

  it("is true at and above the cap", () => {
    expect(roomAtCapacity(conns(ROOM_CONNECTION_CAP))).toBe(true);
    expect(roomAtCapacity(conns(ROOM_CONNECTION_CAP + 5))).toBe(true);
  });

  it("counts lazily and stops at the cap (works on a non-array iterable)", () => {
    let pulled = 0;
    function* infinite(): Generator {
      while (true) {
        pulled += 1;
        yield {};
      }
    }
    expect(roomAtCapacity(infinite())).toBe(true);
    // Stopped as soon as the cap was reached — did not iterate forever.
    expect(pulled).toBe(ROOM_CONNECTION_CAP);
  });
});
