import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("void/env", () => ({
  env: {
    WRIGHTFUL_PUBLIC_URL: "https://wrightful.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789-0123456789-01",
  },
}));
vi.mock("void/storage", () => ({ storage: { get: vi.fn() } }));

const { loadMcpArtifactMock } = vi.hoisted(() => ({
  loadMcpArtifactMock: vi.fn(),
}));
vi.mock("@/lib/mcp/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/queries")>()),
  loadMcpArtifact: loadMcpArtifactMock,
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildMcpServer,
  INLINE_IMAGE_MAX_BYTES,
  isInlineableImage,
  isInlineableText,
} from "@/lib/mcp/server";
import {
  TRACE_TOKEN_TTL_SECONDS,
  verifyArtifactToken,
} from "@/lib/artifact-tokens";
import { ERROR_MESSAGE_SNIPPET_CHARS, truncateText } from "@/lib/mcp/queries";
import type { TenantScope } from "@/lib/scope";

const scope: TenantScope = {
  teamId: "team_abc" as TenantScope["teamId"],
  projectId: "proj_xyz" as TenantScope["projectId"],
  teamSlug: "acme",
  projectSlug: "web",
};

/**
 * Protocol-level contract for the MCP endpoint, exercised through the REAL
 * MCP SDK client over an in-memory linked transport pair — the same
 * `McpServer` instance `routes/api/mcp/index.ts` serves over Streamable HTTP.
 * No DB: `tools/list` and argument validation happen entirely in the protocol
 * layer, which is exactly the contract MCP clients (Claude Code, Cursor, …)
 * depend on. Query behavior against real rows is covered by the e2e suite.
 */
async function connectedClient(): Promise<Client> {
  return connect({ kind: "project", scope });
}

async function connect(
  authz: Parameters<typeof buildMcpServer>[0],
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(authz);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("buildMcpServer tool surface", () => {
  it("exposes exactly the read tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_artifact",
      "get_run",
      "get_test_result",
      "list_flaky_tests",
      "list_runs",
      "list_tests",
    ]);
  });

  it("marks every tool read-only", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("advertises the PR/commit lookup arguments on list_runs", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const listRuns = tools.find((t) => t.name === "list_runs");
    const props = listRuns?.inputSchema.properties ?? {};
    for (const key of [
      "pr",
      "commit",
      "branch",
      "status",
      "from",
      "to",
      "limit",
      "cursor",
    ]) {
      expect(props, `list_runs is missing input "${key}"`).toHaveProperty(key);
    }
  });

  it("rejects a tools/call with missing required arguments before any query runs", async () => {
    // `get_run` requires run_id; the zod layer must refuse it at the protocol
    // boundary (the void/db stub would throw loudly if the handler ran). The
    // SDK reports validation failures as an isError tool result.
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_run", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/run_id/);
  });

  it("rejects a malformed commit argument (not a SHA prefix)", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "list_runs",
      arguments: { commit: "not-a-sha!" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/SHA/);
  });

  it("signs replayable trace URLs for 8 hours and reports that exact lifetime", async () => {
    loadMcpArtifactMock.mockResolvedValueOnce({
      id: "artifact_trace",
      testResultId: "result_1",
      type: "trace",
      name: "trace.zip",
      contentType: "application/zip",
      sizeBytes: 12_345,
      attempt: 0,
      role: null,
      snapshotName: null,
      r2Key: "t/team_abc/p/proj_xyz/runs/run_1/tr/result_1/trace.zip",
    });

    const client = await connectedClient();
    const nowSeconds = 1_800_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    try {
      const result = (await client.callTool({
        name: "get_artifact",
        arguments: { artifact_id: "artifact_trace" },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError).not.toBe(true);
      const block = result.content[0];
      expect(block.type).toBe("text");
      if (typeof block.text !== "string") {
        throw new Error("expected metadata text");
      }
      const meta = JSON.parse(block.text) as {
        downloadUrl: string;
        downloadUrlExpiresInSeconds: number;
        traceViewerUrl: string;
      };
      expect(meta.downloadUrlExpiresInSeconds).toBe(TRACE_TOKEN_TTL_SECONDS);
      expect(meta.traceViewerUrl).toContain("/trace-viewer/index.html");

      const token = new URL(meta.downloadUrl).searchParams.get("t");
      expect(token).not.toBeNull();
      expect(await verifyArtifactToken(token!)).toMatchObject({
        exp: nowSeconds + TRACE_TOKEN_TTL_SECONDS,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("advertises the distinct standard and replay-trace URL lifetimes", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const getArtifact = tools.find((tool) => tool.name === "get_artifact");
    expect(getArtifact?.description).toContain("valid 1 hour normally");
    expect(getArtifact?.description).toContain("8 hours for replayable traces");
  });
});

/**
 * The OAuth-token ("user") authorization shape: no fixed project, so every
 * scoped tool must REQUIRE team+project slugs (membership-checked per call in
 * the handler) and a `list_projects` tool joins the surface. This is the
 * schema contract an OAuth-connected agent sees — if team/project ever became
 * optional, a call would fall through to an unscoped query.
 */
describe("buildMcpServer user-mode tool surface", () => {
  it("adds list_projects alongside the scoped tools", async () => {
    const client = await connect({ kind: "user", userId: "user_1" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_artifact",
      "get_run",
      "get_test_result",
      "list_flaky_tests",
      "list_projects",
      "list_runs",
      "list_tests",
    ]);
  });

  it("REQUIRES team + project on every scoped tool", async () => {
    const client = await connect({ kind: "user", userId: "user_1" });
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (tool.name === "list_projects") continue;
      const required = (tool.inputSchema.required ?? []) as string[];
      expect(required, `${tool.name} must require team`).toContain("team");
      expect(required, `${tool.name} must require project`).toContain(
        "project",
      );
    }
  });

  it("keeps project-mode tools free of tenancy arguments", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = tool.inputSchema.properties ?? {};
      expect(props, `${tool.name} must not take team`).not.toHaveProperty(
        "team",
      );
      expect(props, `${tool.name} must not take project`).not.toHaveProperty(
        "project",
      );
    }
  });
});

describe("inline-content decisions", () => {
  it("inlines only image formats MCP clients render (no SVG, no AVIF)", () => {
    expect(isInlineableImage("image/png")).toBe(true);
    expect(isInlineableImage("image/jpeg")).toBe(true);
    expect(isInlineableImage("Image/PNG; charset=binary")).toBe(true);
    expect(isInlineableImage("image/svg+xml")).toBe(false);
    expect(isInlineableImage("application/zip")).toBe(false);
  });

  it("treats text/* and JSON as inlineable text, binary types not", () => {
    expect(isInlineableText("text/plain")).toBe(true);
    expect(isInlineableText("text/markdown")).toBe(true);
    expect(isInlineableText("application/json")).toBe(true);
    expect(isInlineableText("video/webm")).toBe(false);
    expect(isInlineableText("application/octet-stream")).toBe(false);
  });

  it("keeps the image inline cap at a size hosted MCP clients accept", () => {
    // Claude's hard per-image limit is ~5 MB of base64; 2 MiB raw (≈2.7 MB
    // base64) stays comfortably under it. Bump deliberately, not by accident.
    expect(INLINE_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("truncateText", () => {
  it("returns short text and null unchanged", () => {
    expect(truncateText("boom", 100)).toBe("boom");
    expect(truncateText(null, 100)).toBeNull();
  });

  it("truncates long text with an explicit marker", () => {
    const long = "x".repeat(ERROR_MESSAGE_SNIPPET_CHARS + 500);
    const out = truncateText(long, ERROR_MESSAGE_SNIPPET_CHARS);
    expect(out).toContain("truncated 500 chars");
    expect(out?.startsWith("x".repeat(ERROR_MESSAGE_SNIPPET_CHARS))).toBe(true);
  });
});
