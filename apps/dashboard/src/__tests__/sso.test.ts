import { describe, it, expect } from "vite-plus/test";
import {
  extractEmailDomain,
  normalizeSsoDomain,
  resolveTeamForSsoEmail,
  type TeamSsoClaim,
} from "@/lib/sso";

/**
 * The SSO/OIDC org-mapping v1 pure core (roadmap 3.3). These functions decide
 * which team a user signing in through the IdP is auto-resolved into, by
 * matching their verified email's domain against teams' owner-configured
 * `ssoDomain` claims. The DB-backed `joinTeamForSsoEmail` is thin orchestration
 * over `resolveTeamForSsoEmail`; the matching rules — case-insensitivity, the
 * deliberate NO-sub-domain-collapse choice, and input normalization — are
 * pinned here so the wire is a one-step follow-up against a tested core.
 */
describe("sso org-mapping", () => {
  describe("extractEmailDomain", () => {
    it("returns the lowercased domain after the last @", () => {
      expect(extractEmailDomain("alice@acme.com")).toBe("acme.com");
    });

    it("is case-insensitive on the domain", () => {
      expect(extractEmailDomain("Alice@ACME.com")).toBe("acme.com");
      expect(extractEmailDomain("bob@Acme.Com")).toBe("acme.com");
    });

    it("keeps the full sub-domain (no collapse to the registrable domain)", () => {
      // Documented choice: eng.acme.com matches only a team that claimed
      // exactly eng.acme.com, NOT one that claimed acme.com.
      expect(extractEmailDomain("dev@eng.acme.com")).toBe("eng.acme.com");
    });

    it("uses the LAST @ for addresses with multiple @ (quoted local part)", () => {
      expect(extractEmailDomain('"a@b"@acme.com')).toBe("acme.com");
    });

    it("returns null for malformed input", () => {
      expect(extractEmailDomain("no-at-sign")).toBeNull();
      expect(extractEmailDomain("@acme.com")).toBeNull(); // empty local part
      expect(extractEmailDomain("alice@")).toBeNull(); // empty domain
      expect(extractEmailDomain("alice@localhost")).toBeNull(); // no dot
      expect(extractEmailDomain("alice@acme.")).toBeNull(); // trailing dot
      expect(extractEmailDomain("alice@.com")).toBeNull(); // leading dot
      expect(extractEmailDomain("   @acme.com")).toBeNull(); // whitespace local
    });
  });

  describe("resolveTeamForSsoEmail", () => {
    const claims: TeamSsoClaim[] = [
      { id: "team_acme", ssoDomain: "acme.com" },
      { id: "team_eng", ssoDomain: "eng.acme.com" },
      { id: "team_unclaimed", ssoDomain: null },
    ];

    it("maps a matching email domain to its team", () => {
      expect(resolveTeamForSsoEmail("alice@acme.com", claims)).toBe(
        "team_acme",
      );
    });

    it("matches case-insensitively (email side normalized)", () => {
      expect(resolveTeamForSsoEmail("Alice@ACME.com", claims)).toBe(
        "team_acme",
      );
    });

    it("matches the exact sub-domain, not the parent", () => {
      // eng.acme.com goes to team_eng, NOT team_acme.
      expect(resolveTeamForSsoEmail("dev@eng.acme.com", claims)).toBe(
        "team_eng",
      );
      // A sub-domain with no exact claim does NOT fall back to the parent.
      expect(resolveTeamForSsoEmail("x@sales.acme.com", claims)).toBeNull();
    });

    it("returns null when no team claims the domain", () => {
      expect(resolveTeamForSsoEmail("bob@other.com", claims)).toBeNull();
    });

    it("returns null for a malformed email", () => {
      expect(resolveTeamForSsoEmail("not-an-email", claims)).toBeNull();
    });

    it("never matches a team with a null/empty claim", () => {
      expect(
        resolveTeamForSsoEmail("anyone@anywhere.com", [
          { id: "t1", ssoDomain: null },
          { id: "t2", ssoDomain: "" },
        ]),
      ).toBeNull();
    });

    it("returns null against an empty claim set", () => {
      expect(resolveTeamForSsoEmail("alice@acme.com", [])).toBeNull();
    });
  });

  describe("normalizeSsoDomain", () => {
    it("lowercases and trims a bare domain", () => {
      expect(normalizeSsoDomain("  Acme.COM  ")).toEqual({
        ok: true,
        domain: "acme.com",
      });
      expect(normalizeSsoDomain("eng.acme.com")).toEqual({
        ok: true,
        domain: "eng.acme.com",
      });
    });

    it("treats blank input as clearing the claim (null domain)", () => {
      expect(normalizeSsoDomain("")).toEqual({ ok: true, domain: null });
      expect(normalizeSsoDomain("   ")).toEqual({ ok: true, domain: null });
    });

    it("strips a pasted scheme, leading @, path, and port", () => {
      expect(normalizeSsoDomain("https://acme.com/sso")).toEqual({
        ok: true,
        domain: "acme.com",
      });
      expect(normalizeSsoDomain("http://acme.com")).toEqual({
        ok: true,
        domain: "acme.com",
      });
      expect(normalizeSsoDomain("@acme.com")).toEqual({
        ok: true,
        domain: "acme.com",
      });
      expect(normalizeSsoDomain("acme.com:443")).toEqual({
        ok: true,
        domain: "acme.com",
      });
      expect(normalizeSsoDomain("acme.com/path?q=1#frag")).toEqual({
        ok: true,
        domain: "acme.com",
      });
    });

    it("rejects input that is not a plausible bare domain", () => {
      expect(normalizeSsoDomain("localhost").ok).toBe(false); // no dot
      expect(normalizeSsoDomain("acme .com").ok).toBe(false); // space
      expect(normalizeSsoDomain(".acme.com").ok).toBe(false); // leading dot
      expect(normalizeSsoDomain("acme.com.").ok).toBe(false); // trailing dot
      expect(normalizeSsoDomain("acme_corp.com").ok).toBe(false); // underscore
      expect(normalizeSsoDomain("acme@corp").ok).toBe(false); // stray @ mid-host
    });

    it("round-trips a normalized domain through extract → resolve", () => {
      // The owner-entered claim and the email-derived domain must compare equal.
      const parsed = normalizeSsoDomain("ACME.com");
      expect(parsed).toEqual({ ok: true, domain: "acme.com" });
      const claim = parsed.ok ? parsed.domain : null;
      expect(
        resolveTeamForSsoEmail("alice@Acme.COM", [
          { id: "t", ssoDomain: claim },
        ]),
      ).toBe("t");
    });
  });
});
