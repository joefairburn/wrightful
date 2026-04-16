import { Command } from "commander";
import { access } from "node:fs/promises";
import { parseReport } from "../lib/parser.js";
import { detectCI } from "../lib/ci-detect.js";
import { generateIdempotencyKey } from "../lib/idempotency.js";
import { ApiClient } from "../lib/api-client.js";
import { resolveConfig } from "../lib/config.js";
import * as logger from "../lib/logger.js";
import type { IngestPayload } from "../types.js";

export const uploadCommand = new Command("upload")
  .description("Upload Playwright test results to your Greenroom dashboard")
  .argument("<report-file>", "Path to the Playwright JSON report file")
  .option("--url <url>", "Dashboard URL")
  .option("--token <token>", "API key")
  .option(
    "--artifacts <mode>",
    "Artifact upload mode: all, failed, none",
    "failed",
  )
  .option("--dry-run", "Parse and validate without uploading", false)
  .action(async (reportFile: string, options) => {
    logger.printHeader();

    // Validate report file exists
    try {
      await access(reportFile);
    } catch {
      logger.printError(
        `Report file not found: ${reportFile}\n` +
          `  Hint: Ensure you have the JSON reporter configured in playwright.config.ts:\n` +
          `  reporter: [['json', { outputFile: 'playwright-report.json' }]]`,
      );
      process.exit(3);
    }

    // Parse the report
    let parsed;
    try {
      parsed = await parseReport(reportFile);
    } catch (err) {
      logger.printError(
        err instanceof Error ? err.message : "Failed to parse report",
      );
      process.exit(3);
    }

    logger.printReportInfo(reportFile, parsed.results.length);

    // Detect CI environment
    const ci = detectCI();
    logger.printCIInfo(ci?.ciProvider ?? null);

    // Generate idempotency key
    const idempotencyKey = generateIdempotencyKey(
      ci?.ciBuildId,
      parsed.shardIndex,
    );

    // Build the ingest payload
    const payload: IngestPayload = {
      idempotencyKey,
      run: {
        ciProvider: ci?.ciProvider ?? null,
        ciBuildId: ci?.ciBuildId ?? null,
        branch: ci?.branch ?? null,
        commitSha: ci?.commitSha ?? null,
        commitMessage: ci?.commitMessage ?? null,
        prNumber: ci?.prNumber ?? null,
        repo: ci?.repo ?? null,
        shardIndex: parsed.shardIndex,
        shardTotal: parsed.shardTotal,
        status: parsed.run.status,
        durationMs: parsed.run.durationMs,
        reporterVersion: "0.1.0",
        playwrightVersion: parsed.playwrightVersion,
      },
      results: parsed.results,
    };

    // Dry run: print payload and exit
    if (options.dryRun) {
      console.log("\n--- Dry run: payload ---");
      console.log(JSON.stringify(payload, null, 2));
      process.exit(0);
    }

    // Resolve config (url + token)
    let config;
    try {
      config = await resolveConfig({
        url: options.url,
        token: options.token,
        artifacts: options.artifacts,
      });
    } catch (err) {
      logger.printError(
        err instanceof Error ? err.message : "Configuration error",
      );
      process.exit(2);
    }

    // Upload
    logger.printUploading(config.url);

    try {
      const client = new ApiClient(config.url, config.token);
      const response = await client.ingest(payload);

      logger.printSuccess(
        response,
        config.url,
        parsed.results,
        parsed.run.durationMs,
      );
    } catch (err) {
      logger.printError(err instanceof Error ? err.message : "Upload failed");
      process.exit(1);
    }
  });
