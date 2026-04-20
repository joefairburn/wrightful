import { describe, expect, it } from "vitest";
import { matchesWhitelist, parseList } from "../lib/whitelist";

describe("parseList", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(parseList(null)).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("")).toEqual([]);
    expect(parseList("   ")).toEqual([]);
  });

  it("splits, trims, lowercases, drops empties", () => {
    expect(parseList("Acme, Other-Org ,,  third  ")).toEqual([
      "acme",
      "other-org",
      "third",
    ]);
  });

  it("handles trailing commas", () => {
    expect(parseList("acme,,")).toEqual(["acme"]);
  });
});

describe("matchesWhitelist", () => {
  it("returns false when both allow-lists are empty", () => {
    expect(
      matchesWhitelist(
        { email: "jo@acme.com", orgs: ["acme"] },
        { allowedOrgs: [], allowedDomains: [] },
      ),
    ).toBe(false);
  });

  it("matches on domain", () => {
    expect(
      matchesWhitelist(
        { email: "jo@acme.com", orgs: [] },
        { allowedOrgs: [], allowedDomains: ["acme.com"] },
      ),
    ).toBe(true);
  });

  it("is case-insensitive on domain", () => {
    expect(
      matchesWhitelist(
        { email: "Jo@Acme.Com", orgs: [] },
        { allowedOrgs: [], allowedDomains: ["acme.com"] },
      ),
    ).toBe(true);
  });

  it("matches on org", () => {
    expect(
      matchesWhitelist(
        { email: "jo@other.com", orgs: ["acme", "else"] },
        { allowedOrgs: ["acme"], allowedDomains: [] },
      ),
    ).toBe(true);
  });

  it("is case-insensitive on org", () => {
    expect(
      matchesWhitelist(
        { email: "jo@other.com", orgs: ["ACME"] },
        { allowedOrgs: ["acme"], allowedDomains: [] },
      ),
    ).toBe(true);
  });

  it("rejects when neither matches", () => {
    expect(
      matchesWhitelist(
        { email: "jo@other.com", orgs: ["else"] },
        { allowedOrgs: ["acme"], allowedDomains: ["acme.com"] },
      ),
    ).toBe(false);
  });

  it("accepts when either allow-list matches (OR semantics)", () => {
    expect(
      matchesWhitelist(
        { email: "jo@acme.com", orgs: [] },
        { allowedOrgs: ["other"], allowedDomains: ["acme.com"] },
      ),
    ).toBe(true);
  });

  it("handles emails without an @ safely", () => {
    expect(
      matchesWhitelist(
        { email: "garbage", orgs: [] },
        { allowedOrgs: [], allowedDomains: ["acme.com"] },
      ),
    ).toBe(false);
  });
});
