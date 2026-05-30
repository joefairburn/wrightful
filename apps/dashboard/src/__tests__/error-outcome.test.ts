import { describe, expect, it } from "vite-plus/test";
import {
  isApiPath,
  isErrorPage,
  looksLikeStaticAsset,
  mapErrorOutcome,
  NOT_FOUND_PATH,
  OOPS_PATH,
  shouldLogApiFailure,
} from "@/lib/error-outcome";

describe("isApiPath", () => {
  it("matches /api/ prefixed paths", () => {
    expect(isApiPath("/api/runs")).toBe(true);
    expect(isApiPath("/api/t/acme/p/web/runs/r1/summary")).toBe(true);
  });

  it("does not match HTML routes or bare /api", () => {
    expect(isApiPath("/t/acme/p/web")).toBe(false);
    expect(isApiPath("/login")).toBe(false);
    expect(isApiPath("/api")).toBe(false);
    expect(isApiPath("/apidocs")).toBe(false);
  });
});

describe("isErrorPage", () => {
  it("identifies the loop-guarded error pages exactly", () => {
    expect(isErrorPage(OOPS_PATH)).toBe(true);
    expect(isErrorPage(NOT_FOUND_PATH)).toBe(true);
    expect(isErrorPage("/oopsie")).toBe(false);
    expect(isErrorPage("/not-found/extra")).toBe(false);
    expect(isErrorPage("/")).toBe(false);
  });
});

describe("looksLikeStaticAsset", () => {
  it("treats a dotted final segment as a dev/static asset", () => {
    expect(looksLikeStaticAsset("/pages/t/layout.tsx")).toBe(true);
    expect(looksLikeStaticAsset("/assets/app.css")).toBe(true);
    expect(looksLikeStaticAsset("/favicon.ico")).toBe(true);
  });

  it("does not match route paths without a dotted final segment", () => {
    expect(looksLikeStaticAsset("/t/acme/p/web")).toBe(false);
    expect(looksLikeStaticAsset("/t/acme.co/p/web")).toBe(false);
    expect(looksLikeStaticAsset("/")).toBe(false);
  });
});

describe("mapErrorOutcome", () => {
  it("maps 401 to a login redirect", () => {
    expect(mapErrorOutcome(401)).toEqual({ kind: "redirect-login" });
  });

  it("maps 404 to a status-preserving not-found rewrite", () => {
    expect(mapErrorOutcome(404)).toEqual({ kind: "rewrite-404", status: 404 });
  });

  it("maps 5xx to log-and-oops preserving the original status", () => {
    expect(mapErrorOutcome(500)).toEqual({ kind: "log-and-oops", status: 500 });
    expect(mapErrorOutcome(503)).toEqual({ kind: "log-and-oops", status: 503 });
  });

  it("maps an unknown/raw throw (null status) to log-and-oops defaulting to 500", () => {
    expect(mapErrorOutcome(null)).toEqual({
      kind: "log-and-oops",
      status: 500,
    });
  });

  it("routes other 4xx through log-and-oops (no dedicated arm)", () => {
    // 403/400 etc. are not handled by a dedicated case today; they fall to the
    // oops arm. Locking this so a future 403 case is a deliberate change here,
    // not an accidental drift across the two middleware arms.
    expect(mapErrorOutcome(403)).toEqual({ kind: "log-and-oops", status: 403 });
    expect(mapErrorOutcome(400)).toEqual({ kind: "log-and-oops", status: 400 });
  });
});

describe("shouldLogApiFailure", () => {
  it("logs raw throws (null status) and 5xx", () => {
    expect(shouldLogApiFailure(null)).toBe(true);
    expect(shouldLogApiFailure(500)).toBe(true);
    expect(shouldLogApiFailure(502)).toBe(true);
  });

  it("stays quiet for intentional 4xx control-flow responses", () => {
    expect(shouldLogApiFailure(400)).toBe(false);
    expect(shouldLogApiFailure(401)).toBe(false);
    expect(shouldLogApiFailure(404)).toBe(false);
    expect(shouldLogApiFailure(409)).toBe(false);
  });
});
