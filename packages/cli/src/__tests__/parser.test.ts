import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parseReport } from "../lib/parser.js";

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  "../../test-fixtures/sample-report.json",
);

describe("parseReport", () => {
  it("parses a valid Playwright JSON report", async () => {
    const result = await parseReport(FIXTURE_PATH);
    expect(result.results).toHaveLength(4);
    expect(result.playwrightVersion).toBe("1.50.0");
  });

  it("computes correct run status (failed if any test failed)", async () => {
    const result = await parseReport(FIXTURE_PATH);
    expect(result.run.status).toBe("failed");
  });

  it("extracts duration from stats", async () => {
    const result = await parseReport(FIXTURE_PATH);
    expect(result.run.durationMs).toBe(19134);
  });

  it("maps expected → passed", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const checkout = result.results.find((r) =>
      r.title.includes("should complete checkout"),
    );
    expect(checkout?.status).toBe("passed");
  });

  it("maps unexpected → failed", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const refund = result.results.find((r) =>
      r.title.includes("should handle refund"),
    );
    expect(refund?.status).toBe("failed");
  });

  it("maps flaky status correctly", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const login = result.results.find((r) =>
      r.title.includes("should redirect to login"),
    );
    expect(login?.status).toBe("flaky");
  });

  it("extracts error from failing result for flaky tests", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const login = result.results.find((r) =>
      r.title.includes("should redirect to login"),
    );
    expect(login?.errorMessage).toBe("Timeout exceeded");
    expect(login?.retryCount).toBe(1);
  });

  it("sums duration across retries for flaky tests", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const login = result.results.find((r) =>
      r.title.includes("should redirect to login"),
    );
    // 2100 + 3200 = 5300
    expect(login?.durationMs).toBe(5300);
  });

  it("extracts tags from specs", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const checkout = result.results.find((r) =>
      r.title.includes("should complete checkout"),
    );
    expect(checkout?.tags).toEqual(["@smoke", "@payments"]);
  });

  it("extracts annotations from tests", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const refund = result.results.find((r) =>
      r.title.includes("should handle refund"),
    );
    expect(refund?.annotations).toEqual([
      { type: "issue", description: "GH-42" },
    ]);
  });

  it("builds full title paths with nested suites", async () => {
    const result = await parseReport(FIXTURE_PATH);
    const checkout = result.results.find((r) =>
      r.title.includes("should complete checkout"),
    );
    expect(checkout?.title).toBe(
      "tests/payment.spec.ts > Payment flow > should complete checkout",
    );
  });

  it("generates stable 16-char hex test IDs", async () => {
    const result = await parseReport(FIXTURE_PATH);
    for (const r of result.results) {
      expect(r.testId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("extracts projectName from tests", async () => {
    const result = await parseReport(FIXTURE_PATH);
    for (const r of result.results) {
      expect(r.projectName).toBe("chromium");
    }
  });

  it("handles null shard info", async () => {
    const result = await parseReport(FIXTURE_PATH);
    expect(result.shardIndex).toBeNull();
    expect(result.shardTotal).toBeNull();
  });

  it("throws on nonexistent file", async () => {
    await expect(parseReport("/nonexistent/file.json")).rejects.toThrow();
  });

  it("throws on invalid JSON", async () => {
    // Create a temp file with bad JSON
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmp = "/tmp/greenroom-bad.json";
    await writeFile(tmp, "not json");
    await expect(parseReport(tmp)).rejects.toThrow("Failed to parse JSON");
    await unlink(tmp);
  });

  it("throws on missing suites", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmp = "/tmp/greenroom-no-suites.json";
    await writeFile(tmp, JSON.stringify({ config: {}, stats: {} }));
    await expect(parseReport(tmp)).rejects.toThrow("Invalid Playwright report");
    await unlink(tmp);
  });
});
