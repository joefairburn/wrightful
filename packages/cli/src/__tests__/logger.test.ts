import { describe, it, expect, vi, beforeEach } from "vitest";
import * as logger from "../lib/logger.js";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("printHeader includes version", () => {
    logger.printHeader();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Greenroom v"));
  });

  it("printReportInfo shows file path and test count", () => {
    logger.printReportInfo("report.json", 42);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("report.json"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("42 tests"),
    );
  });

  it("printCIInfo shows provider when detected", () => {
    logger.printCIInfo("github-actions");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("github-actions"),
    );
  });

  it("printCIInfo shows local when no CI", () => {
    logger.printCIInfo(null);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("locally"),
    );
  });

  it("printSuccess shows counts and run URL", () => {
    logger.printSuccess(
      { runId: "abc", runUrl: "/runs/abc" },
      "https://dash.example.com",
      [
        { status: "passed", title: "t1", testId: "1", file: "f", projectName: null, durationMs: 100, retryCount: 0, errorMessage: null, errorStack: null, workerIndex: 0, tags: [], annotations: [] },
        { status: "failed", title: "t2", testId: "2", file: "f", projectName: null, durationMs: 200, retryCount: 0, errorMessage: "err", errorStack: null, workerIndex: 0, tags: [], annotations: [] },
      ],
      300,
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 passed"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 failed"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("/runs/abc"),
    );
  });

  it("printSuccess shows duplicate message", () => {
    logger.printSuccess(
      { runId: "abc", runUrl: "/runs/abc", duplicate: true },
      "https://dash.example.com",
      [],
      0,
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("duplicate"),
    );
  });

  it("printError writes to stderr", () => {
    logger.printError("something broke");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("something broke"),
    );
  });
});
