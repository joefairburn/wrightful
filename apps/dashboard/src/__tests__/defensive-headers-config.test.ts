import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("void", () => ({
  defineMiddleware: (fn: unknown) => fn,
}));

const {
  GLOBAL_CONTENT_SECURITY_POLICY,
  R2_S3_CSP_ORIGIN,
  TRACE_VIEWER_CONTENT_SECURITY_POLICY,
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
