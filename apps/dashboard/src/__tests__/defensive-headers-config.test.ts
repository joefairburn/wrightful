import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("void", () => ({
  defineMiddleware: (fn: unknown) => fn,
}));

// Mutable so the snapshot-CSP origin-gating suite can flip between same-origin
// and separate-viewer-origin modes per test (`traceViewerOrigin` reads env at
// call time).
const config = vi.hoisted(() => ({
  VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: undefined as string | undefined,
}));
vi.mock("void/env", () => ({ env: config }));

const {
  GLOBAL_CONTENT_SECURITY_POLICY,
  R2_S3_CSP_ORIGIN,
  TRACE_VIEWER_CONTENT_SECURITY_POLICY,
  TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY,
  default: defensiveHeaders,
} = await import("../../middleware/00.defensive-headers");

const here = dirname(fileURLToPath(import.meta.url));

function readAppFile(path: string): string {
  return readFileSync(join(here, "../..", path), "utf8");
}

function directive(policy: string, name: string): string {
  const value = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  if (!value) throw new Error(`missing ${name} directive`);
  return value;
}

describe("defensive header CSP configuration", () => {
  it("allows presigned R2 artifact redirects only where dashboard pages need them", () => {
    expect(directive(GLOBAL_CONTENT_SECURITY_POLICY, "img-src")).toContain(
      R2_S3_CSP_ORIGIN,
    );
    expect(directive(GLOBAL_CONTENT_SECURITY_POLICY, "media-src")).toContain(
      R2_S3_CSP_ORIGIN,
    );
    expect(directive(GLOBAL_CONTENT_SECURITY_POLICY, "connect-src")).toContain(
      R2_S3_CSP_ORIGIN,
    );
  });

  it("allows the trace viewer to range-fetch a presigned R2 trace", () => {
    expect(
      directive(TRACE_VIEWER_CONTENT_SECURITY_POLICY, "connect-src"),
    ).toContain(R2_S3_CSP_ORIGIN);
  });

  it("forbids scripts on the attacker-craftable snapshot documents", () => {
    expect(
      directive(TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY, "script-src"),
    ).toBe("script-src 'none'");
    expect(TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY).not.toContain(
      "unsafe-eval",
    );
    expect(
      directive(TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY, "img-src"),
    ).toContain(R2_S3_CSP_ORIGIN);
    expect(TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY).toContain(
      "object-src 'none'",
    );
  });

  it("keeps the managed-edge policies synchronized with the worker", () => {
    const config = JSON.parse(readAppFile("void.json")) as {
      routing: { headers: Record<string, string[]> };
    };

    expect(config.routing.headers["/*"]).toContain(
      `Content-Security-Policy: ${GLOBAL_CONTENT_SECURITY_POLICY}`,
    );
    expect(config.routing.headers["/trace-viewer/*"]).toContain(
      `Content-Security-Policy: ${TRACE_VIEWER_CONTENT_SECURITY_POLICY}`,
    );
  });

  it("keeps the own-account static trace-viewer policy synchronized", () => {
    expect(readAppFile("public/_headers")).toContain(
      `Content-Security-Policy: ${TRACE_VIEWER_CONTENT_SECURITY_POLICY}`,
    );
  });
});

describe("snapshot CSP origin gating (worker responses)", () => {
  afterEach(() => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = undefined;
  });

  /** Run the middleware for `url` and return the stamped CSP header. */
  async function stampedCsp(url: string): Promise<string | null> {
    const middleware = defensiveHeaders as unknown as (
      c: unknown,
      next: () => Promise<void>,
    ) => Promise<void>;
    const c = {
      req: { path: new URL(url).pathname, url },
      res: undefined as Response | undefined,
    };
    await middleware(c, async () => {
      c.res = new Response("snapshot");
    });
    return c.res?.headers.get("content-security-policy") ?? null;
  }

  it("same-origin mode: snapshots get the script-less policy", async () => {
    expect(
      await stampedCsp("https://dash.example.com/trace-viewer/snapshot/p1"),
    ).toBe(TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY);
  });

  it("separate mode: the DASHBOARD origin keeps the script-less policy — the same Worker serves both hosts, and session-origin snapshots must never run scripts", async () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "https://traces.example.com";
    expect(
      await stampedCsp("https://dash.example.com/trace-viewer/snapshot/p1"),
    ).toBe(TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY);
  });

  it("separate mode: only the cookieless viewer host gets the regular trace-viewer policy", async () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "https://traces.example.com";
    expect(
      await stampedCsp("https://traces.example.com/trace-viewer/snapshot/p1"),
    ).toBe(TRACE_VIEWER_CONTENT_SECURITY_POLICY);
  });

  it("non-snapshot trace-viewer paths keep the regular policy everywhere", async () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "https://traces.example.com";
    expect(
      await stampedCsp("https://dash.example.com/trace-viewer/bridge.html"),
    ).toBe(TRACE_VIEWER_CONTENT_SECURITY_POLICY);
  });
});

/**
 * Playwright's stock HTML shells (`index.html`, `snapshot.html`, `uiMode.html`)
 * frame DOM snapshots with a HARDCODED `sandbox="allow-same-origin
 * allow-scripts"` we cannot override. Trace bytes are attacker-craftable, so on
 * the session origin that shell is a stored-XSS path — and because these are
 * static assets, reachable by typing the URL, refusing to serve them is the only
 * real boundary (gating the MCP link / the pane popout removes the invitation,
 * not the path). They stay vendored: on a cookieless viewer host they ARE the
 * full-fidelity viewer.
 */
describe("scripted snapshot shells are refused off the viewer host", () => {
  afterEach(() => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = undefined;
  });

  /** Run the middleware for `url`, reporting whether the asset was served. */
  async function statusFor(
    url: string,
  ): Promise<{ status: number; servedAsset: boolean }> {
    const middleware = defensiveHeaders as unknown as (
      c: unknown,
      next: () => Promise<void>,
    ) => Promise<void>;
    let servedAsset = false;
    const c = {
      req: { path: new URL(url).pathname, url },
      res: undefined as Response | undefined,
    };
    await middleware(c, async () => {
      servedAsset = true;
      c.res = new Response("<html>stock viewer</html>", {
        headers: { "Content-Type": "text/html" },
      });
    });
    return { status: c.res?.status ?? 0, servedAsset };
  }

  const SHELLS = [
    "/trace-viewer/index.html",
    "/trace-viewer/snapshot.html",
    "/trace-viewer/uiMode.html",
  ];

  it("same-origin mode: 404s every shell without reaching the asset layer", async () => {
    for (const path of SHELLS) {
      const result = await statusFor(`https://dash.example.com${path}`);
      expect(result.status, path).toBe(404);
      // Short-circuited: the bytes are never even fetched.
      expect(result.servedAsset, path).toBe(false);
    }
  });

  it("separate mode: the DASHBOARD origin still 404s them", async () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "https://traces.example.com";
    for (const path of SHELLS) {
      expect(
        (await statusFor(`https://dash.example.com${path}`)).status,
        path,
      ).toBe(404);
    }
  });

  it("separate mode: the cookieless viewer host serves them (full-fidelity replay)", async () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "https://traces.example.com";
    for (const path of SHELLS) {
      const result = await statusFor(`https://traces.example.com${path}`);
      expect(result.status, path).toBe(200);
      expect(result.servedAsset, path).toBe(true);
    }
  });

  it("leaves the files our own viewer depends on alone", async () => {
    for (const path of [
      "/trace-viewer/bridge.html",
      "/trace-viewer/sw.bundle.js",
      "/trace-viewer/snapshot/p1",
    ]) {
      expect(
        (await statusFor(`https://dash.example.com${path}`)).status,
        path,
      ).toBe(200);
    }
  });
});
