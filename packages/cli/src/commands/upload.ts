import { Command } from "commander";
import { access } from "node:fs/promises";
import { parseReport } from "../lib/parser.js";
import { detectCI } from "../lib/ci-detect.js";
import { generateIdempotencyKey } from "../lib/idempotency.js";
import {
  ApiClient,
  runWithLimit,
  type PresignArtifactRequest,
} from "../lib/api-client.js";
import { resolveConfig } from "../lib/config.js";
import {
  collectArtifacts,
  type ArtifactMode,
} from "../lib/artifact-collector.js";
import * as logger from "../lib/logger.js";
import type { IngestPayload } from "../types.js";

const PRESIGN_BATCH_SIZE = 50;
const UPLOAD_CONCURRENCY = 4;

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

    const client = new ApiClient(config.url, config.token);
    let response;
    try {
      response = await client.ingest(payload);
    } catch (err) {
      logger.printError(err instanceof Error ? err.message : "Upload failed");
      process.exit(1);
    }

    logger.printSuccess(
      response,
      config.url,
      parsed.results,
      parsed.run.durationMs,
    );

    // Artifact upload (non-fatal on failure)
    if (!response.duplicate) {
      await uploadArtifactsBestEffort(
        client,
        response.runId,
        response.results ?? [],
        parsed.report,
        config.artifacts,
      );
    }
  });

async function uploadArtifactsBestEffort(
  client: ApiClient,
  runId: string,
  mapping: Array<{ clientKey: string; testResultId: string }>,
  report: Parameters<typeof collectArtifacts>[0],
  mode: ArtifactMode,
): Promise<void> {
  if (mode === "none") return;

  if (mapping.length === 0) {
    logger.printArtifactError(
      "(all)",
      "server did not return a clientKey → testResultId mapping (is the dashboard on protocol v2?)",
    );
    return;
  }

  const manifest = await collectArtifacts(report, mode);
  if (manifest.artifacts.length === 0) return;

  const byClientKey = new Map(
    mapping.map((m) => [m.clientKey, m.testResultId]),
  );

  const presignRequests: Array<PresignArtifactRequest & { localPath: string }> =
    [];
  let skipped = 0;
  for (const a of manifest.artifacts) {
    const testResultId = byClientKey.get(a.clientKey);
    if (!testResultId) {
      skipped++;
      continue;
    }
    presignRequests.push({
      testResultId,
      type: a.type,
      name: a.name,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      localPath: a.localPath,
    });
  }

  if (presignRequests.length === 0) {
    logger.printArtifactsSummary(0, skipped, 0);
    return;
  }

  let uploaded = 0;
  let failed = 0;

  // Batch presign to stay under request-size limits
  for (let i = 0; i < presignRequests.length; i += PRESIGN_BATCH_SIZE) {
    const chunk = presignRequests.slice(i, i + PRESIGN_BATCH_SIZE);
    let uploads;
    try {
      uploads = await client.presign(runId, chunk);
    } catch (err) {
      failed += chunk.length;
      logger.printArtifactError(
        `batch ${i / PRESIGN_BATCH_SIZE}`,
        err instanceof Error ? err.message : "presign failed",
      );
      continue;
    }

    const tasks = chunk.map((req, idx) => async () => {
      const upload = uploads[idx];
      await client.uploadArtifact(
        upload.url,
        req.localPath,
        req.contentType,
        req.sizeBytes,
      );
    });

    const results = await runWithLimit(UPLOAD_CONCURRENCY, tasks);
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.ok) {
        uploaded++;
      } else {
        failed++;
        logger.printArtifactError(chunk[j].name, result.error.message);
      }
    }
  }

  logger.printArtifactsSummary(uploaded, skipped, failed);
}
