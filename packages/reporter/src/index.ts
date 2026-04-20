import { realpath } from "node:fs/promises";
import { relative as relativePath } from "node:path";
import type {
  Reporter,
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  classifyAttachment,
  safeResolvedPath,
  safeSize,
  type ArtifactType,
} from "./attachments.js";
import { Batcher } from "./batcher.js";
import { detectCI, generateIdempotencyKey } from "./ci.js";
import { AuthError, StreamClient } from "./client.js";
import { computeTestId } from "./test-id.js";
import type {
  ArtifactMode,
  ArtifactRegistration,
  ReporterOptions,
  TestAttemptPayload,
  TestResultPayload,
} from "./types.js";

const REPORTER_VERSION = "0.1.0";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_ARTIFACT_MODE: ArtifactMode = "failed";
const ARTIFACT_UPLOAD_CONCURRENCY = 4;
// Best-effort `/complete` attempt fired from a signal handler. Kept short so
// we don't hold the process open past when the OS would SIGKILL anyway.
const SHUTDOWN_COMPLETE_TIMEOUT_MS = 3_000;

function warn(message: string): void {
  // Reporter must never fail the suite. All user-facing messaging goes to
  // stderr, prefixed so Playwright's default reporter output stays readable.
  process.stderr.write(`[wrightful] ${message}\n`);
}

interface PreparedArtifact {
  type: ArtifactType;
  name: string;
  contentType: string;
  sizeBytes: number;
  localPath: string;
  attempt: number;
}

interface PendingTest {
  test: TestCase;
  results: TestResult[];
}

interface EnqueuedTest {
  payload: TestResultPayload;
  artifacts: PreparedArtifact[];
}

/**
 * Playwright reporter that streams one row per test to a Wrightful
 * dashboard as each test reaches its final outcome. Retried tests are
 * aggregated into a single `flaky` row.
 *
 * Configure in playwright.config.ts:
 *
 *   reporter: [['@wrightful/reporter', { url, token, environment }]]
 *
 * Credentials can also come from env: `WRIGHTFUL_URL`, `WRIGHTFUL_TOKEN`.
 *
 * Failure mode semantics:
 *   - Network errors during streaming are logged; the dashboard may show
 *     partial data. Run the suite again and the deterministic idempotency
 *     key will recover the same run.
 *   - If `onEnd` never fires (CI killed with SIGKILL) the run stays at
 *     `status='running'` until the dashboard's cron watchdog sweeps it
 *     (typically within ~30 minutes) and marks it `'interrupted'`.
 *   - SIGTERM / SIGINT trigger a best-effort `/complete` with
 *     `status='interrupted'` before exit.
 */
export default class WrightfulReporter implements Reporter {
  private client: StreamClient | null = null;
  private runId: string | null = null;
  private batcher: Batcher<EnqueuedTest> | null = null;
  private pending: Map<string, PendingTest> = new Map();
  private artifactTasks: Promise<void>[] = [];
  private allowedRoot = "";
  private artifactMode: ArtifactMode = DEFAULT_ARTIFACT_MODE;
  private rootDir: string | null = null;
  private startedAt = 0;
  private playwrightVersion = "unknown";
  // Observability counters surfaced in the end-of-suite summary line.
  private streamed = 0;
  private streamFailed = 0;
  private artifactsOk = 0;
  private artifactsFailed = 0;
  // Signal-handler state so we only attempt the shutdown /complete once.
  private shuttingDown = false;
  private signalHandlersInstalled = false;

  constructor(private options: ReporterOptions = {}) {}

  private get baseUrl(): string | null {
    return this.options.url ?? process.env.WRIGHTFUL_URL ?? null;
  }
  private get token(): string | null {
    return this.options.token ?? process.env.WRIGHTFUL_TOKEN ?? null;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.playwrightVersion = config.version ?? "unknown";
    this.artifactMode = this.options.artifacts ?? DEFAULT_ARTIFACT_MODE;
    this.rootDir = config.rootDir ?? null;

    const baseUrl = this.baseUrl;
    const token = this.token;
    if (!baseUrl || !token) {
      warn("WRIGHTFUL_URL or WRIGHTFUL_TOKEN not set — streaming disabled.");
      return;
    }

    this.client = new StreamClient(baseUrl, token);

    const allTests = suite.allTests();
    const plannedTests = allTests.map((t) =>
      buildTestDescriptor(t, this.rootDir),
    );

    const ci = detectCI();
    const payload = {
      idempotencyKey: generateIdempotencyKey(ci?.ciBuildId),
      run: {
        ciProvider: ci?.ciProvider ?? null,
        ciBuildId: ci?.ciBuildId ?? null,
        branch: ci?.branch ?? null,
        environment: this.options.environment ?? null,
        commitSha: ci?.commitSha ?? null,
        commitMessage: ci?.commitMessage ?? null,
        prNumber: ci?.prNumber ?? null,
        repo: ci?.repo ?? null,
        actor: ci?.actor ?? null,
        reporterVersion: REPORTER_VERSION,
        playwrightVersion: this.playwrightVersion,
        expectedTotalTests: plannedTests.length,
        plannedTests,
      },
    };

    // Open the run in the background so enqueues can start immediately. The
    // batcher's sequential flush chain naturally waits for runId before any
    // appendResults call fires.
    const openPromise = this.client.openRun(payload).then(
      (r) => {
        this.runId = r.runId;
      },
      (err: Error) => {
        if (err instanceof AuthError) {
          warn(err.message);
        } else {
          warn(`openRun failed: ${err.message}. Streaming disabled.`);
        }
        this.client = null;
      },
    );

    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const flushIntervalMs =
      this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    this.batcher = new Batcher<EnqueuedTest>({
      batchSize,
      flushIntervalMs,
      flush: async (batch) => {
        await openPromise;
        if (!this.client || !this.runId) {
          this.streamFailed += batch.length;
          return;
        }
        const mapping = await this.client.appendResults(
          this.runId,
          batch.map((e) => e.payload),
        );
        this.streamed += batch.length;
        this.fireArtifactUploads(batch, mapping);
      },
      onFailure: (batch, err) => {
        if (err instanceof AuthError) {
          warn(err.message);
        } else {
          warn(
            `appendResults failed: ${err.message}. ${batch.length} result(s) dropped.`,
          );
        }
        this.streamFailed += batch.length;
      },
    });

    // Resolve the cwd-based root used to validate attachment paths. Doing
    // this once up-front avoids a per-attachment realpath on cwd.
    this.artifactTasks.push(
      realpath(process.cwd()).then(
        (p) => {
          this.allowedRoot = p;
        },
        () => {
          this.allowedRoot = process.cwd();
        },
      ),
    );

    this.installSignalHandlers();
  }

  /**
   * Best-effort SIGTERM/SIGINT handlers. GitHub Actions sends SIGTERM first
   * on cancellation, then SIGKILL ~10s later. We use that grace window to
   * mark the run `interrupted`. SIGKILL itself is uncatchable; the
   * dashboard's cron watchdog handles that case.
   */
  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const handle = (signal: NodeJS.Signals) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      warn(`received ${signal} — attempting best-effort /complete.`);
      const task = async () => {
        if (this.client && this.runId) {
          try {
            await this.client.completeRun(
              this.runId,
              "interrupted",
              Date.now() - this.startedAt,
              { maxRetries: 0, timeoutMs: SHUTDOWN_COMPLETE_TIMEOUT_MS },
            );
          } catch {
            // Intentionally swallow — we're on our way out either way. The
            // dashboard watchdog picks up anything we didn't finalize.
          }
        }
        process.exit(signal === "SIGTERM" ? 143 : 130);
      };
      void task();
    };
    process.once("SIGTERM", handle);
    process.once("SIGINT", handle);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.batcher) return;

    const testKey = makeTestKey(test);
    const entry = this.pending.get(testKey) ?? { test, results: [] };
    entry.results.push(result);
    this.pending.set(testKey, entry);

    if (!isTestDone(test, result)) return;

    this.pending.delete(testKey);
    this.artifactTasks.push(this.enqueueDone(entry));
  }

  private async enqueueDone(entry: PendingTest): Promise<void> {
    const payload = buildPayload(entry, this.rootDir);
    const attachments =
      this.artifactMode === "none"
        ? []
        : shouldCollectArtifacts(this.artifactMode, entry.test)
          ? await this.collectArtifacts(entry)
          : [];
    this.batcher?.enqueue({ payload, artifacts: attachments });
  }

  private async collectArtifacts(
    entry: PendingTest,
  ): Promise<PreparedArtifact[]> {
    // Ensure allowedRoot has been resolved before we validate any paths.
    await Promise.all(this.artifactTasks.filter(Boolean));
    const out: PreparedArtifact[] = [];
    for (const result of entry.results) {
      for (const attachment of result.attachments ?? []) {
        // Only on-disk attachments (those with a `path`) are uploaded.
        // Inline body attachments are typically small diagnostic text
        // embedded in the report — we skip them.
        if (!attachment.path) continue;
        const resolved = await safeResolvedPath(
          attachment.path,
          this.allowedRoot,
        );
        if (!resolved) continue;
        const size = await safeSize(resolved);
        if (size === null) continue;
        out.push({
          type: classifyAttachment(attachment.name, attachment.contentType),
          name: attachment.name,
          contentType: attachment.contentType,
          sizeBytes: size,
          localPath: resolved,
          attempt: result.retry,
        });
      }
    }
    return out;
  }

  private fireArtifactUploads(
    batch: EnqueuedTest[],
    mapping: Array<{ clientKey: string; testResultId: string }>,
  ): void {
    const byClientKey = new Map(
      mapping.map((m) => [m.clientKey, m.testResultId] as const),
    );
    const registrations: ArtifactRegistration[] = [];
    const locals: PreparedArtifact[] = [];
    for (const entry of batch) {
      if (entry.artifacts.length === 0) continue;
      const testResultId = byClientKey.get(entry.payload.clientKey);
      if (!testResultId) continue;
      for (const a of entry.artifacts) {
        registrations.push({
          testResultId,
          type: a.type,
          name: a.name,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          attempt: a.attempt,
        });
        locals.push(a);
      }
    }
    if (registrations.length === 0) return;
    this.artifactTasks.push(this.uploadArtifactBatch(registrations, locals));
  }

  private async uploadArtifactBatch(
    registrations: ArtifactRegistration[],
    locals: PreparedArtifact[],
  ): Promise<void> {
    if (!this.client || !this.runId) return;
    let uploads;
    try {
      uploads = await this.client.registerArtifacts(this.runId, registrations);
    } catch (err) {
      warn(
        `artifact register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.artifactsFailed += registrations.length;
      return;
    }
    // Bounded-parallelism workers so large batches don't open hundreds of
    // sockets simultaneously.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        if (i >= uploads.length) return;
        const upload = uploads[i];
        const local = locals[i];
        if (!upload || !local || !this.client) continue;
        try {
          await this.client.uploadArtifact(
            upload.uploadUrl,
            local.localPath,
            local.contentType,
            local.sizeBytes,
          );
          this.artifactsOk++;
        } catch (err) {
          this.artifactsFailed++;
          warn(
            `artifact PUT failed (${local.name}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ARTIFACT_UPLOAD_CONCURRENCY, uploads.length) },
        () => worker(),
      ),
    );
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.shuttingDown) return;

    // Any test whose "done" trigger never fired (e.g. interrupted worker
    // killed the run mid-attempt) gets flushed here with whatever state we
    // have. Better to report partial data than lose it.
    for (const entry of this.pending.values()) {
      this.artifactTasks.push(this.enqueueDone(entry));
    }
    this.pending.clear();

    if (this.batcher) {
      await this.batcher.drain();
    }
    // After drain, in-flight artifact uploads may still be pending. Wait.
    await Promise.all(this.artifactTasks);

    const durationMs = Date.now() - this.startedAt;

    let completeFailed = false;
    if (this.client && this.runId) {
      const status = mapFullResultStatus(result.status);
      try {
        await this.client.completeRun(this.runId, status, durationMs);
      } catch (err) {
        completeFailed = true;
        warn(
          `completeRun failed after retries: ${err instanceof Error ? err.message : String(err)}`,
        );
        warn(
          "Run may remain at status='running' until the dashboard watchdog finalizes it (typically within ~30 minutes).",
        );
      }
    }

    this.emitSummary(completeFailed);
  }

  private emitSummary(completeFailed: boolean): void {
    const total = this.streamed + this.streamFailed;
    const parts = [`streamed ${this.streamed}/${total} test(s)`];
    const totalArtifacts = this.artifactsOk + this.artifactsFailed;
    if (totalArtifacts > 0) {
      parts.push(`uploaded ${this.artifactsOk}/${totalArtifacts} artifact(s)`);
    }
    if (this.streamFailed > 0) {
      parts.push(`${this.streamFailed} result(s) dropped`);
    }
    if (completeFailed) {
      parts.push("complete call failed — watchdog will finalize");
    }
    warn(parts.join("; ") + ".");
  }

  printsToStdio(): boolean {
    return false;
  }
}

function makeTestKey(test: TestCase): string {
  // Playwright assigns a stable `id` per test per run.
  return test.id;
}

export function isTestDone(test: TestCase, result: TestResult): boolean {
  if (result.status === "passed") return true;
  if (result.status === "skipped") return true;
  if (result.status === "interrupted") return true;
  // Final attempt: no more retries configured.
  return result.retry >= test.retries;
}

/**
 * Extract the identifying fields for a test case (file, title, project,
 * derived testId). Used by both the open-run prefill (to send the full
 * planned list at onBegin) and `buildPayload` (when a test actually emits
 * a result) — so the same test lands with the same testId, enabling the
 * server to upsert /results rows onto the prefilled queued row.
 */
export function buildTestDescriptor(
  test: TestCase,
  rootDir: string | null,
): {
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
} {
  const projectName = test.parent.project()?.name ?? "";
  const titlePath = test.titlePath().filter(Boolean);
  const absoluteFile = test.location.file;
  const file = rootDir ? relativePath(rootDir, absoluteFile) : absoluteFile;
  const testId = computeTestId(file, titlePath, projectName);
  return {
    testId,
    title: titlePath.join(" > "),
    file,
    projectName: projectName || null,
  };
}

/** Playwright uses "timedOut"; our wire format uses "timedout". */
function normaliseAttemptStatus(
  status: TestResult["status"],
): TestAttemptPayload["status"] {
  if (status === "timedOut") return "timedout";
  if (status === "failed") return "failed";
  if (status === "passed") return "passed";
  // "interrupted" and anything unexpected → surface as skipped rather than
  // invent a new enum value on the wire.
  return "skipped";
}

export function buildPayload(
  entry: PendingTest,
  rootDir: string | null = null,
): TestResultPayload {
  const { test, results } = entry;
  const descriptor = buildTestDescriptor(test, rootDir);

  const totalDuration = results.reduce((s, r) => s + r.duration, 0);
  const lastResult = results[results.length - 1];
  const failing = results.find(
    (r) => r.status === "failed" || r.status === "timedOut",
  );

  const status = mapOutcome(test, lastResult);
  const errorSource = status === "flaky" ? failing : lastResult;

  // One entry per Playwright attempt, ordered by `retry` (0 = initial).
  // Preserves each attempt's own error instead of collapsing to one, so
  // the test detail page can stop inferring which attempt "carries" the
  // failure.
  const attempts: TestAttemptPayload[] = [...results]
    .sort((a, b) => a.retry - b.retry)
    .map((r) => ({
      attempt: r.retry,
      status: normaliseAttemptStatus(r.status),
      durationMs: Math.round(r.duration),
      errorMessage: r.errors?.[0]?.message ?? null,
      errorStack: r.errors?.[0]?.stack ?? null,
    }));

  return {
    clientKey: descriptor.testId,
    testId: descriptor.testId,
    title: descriptor.title,
    file: descriptor.file,
    projectName: descriptor.projectName,
    status,
    durationMs: Math.round(totalDuration),
    retryCount: Math.max(0, results.length - 1),
    errorMessage: errorSource?.errors?.[0]?.message ?? null,
    errorStack: errorSource?.errors?.[0]?.stack ?? null,
    workerIndex:
      lastResult && lastResult.workerIndex >= 0 ? lastResult.workerIndex : 0,
    tags: test.tags ?? [],
    annotations: test.annotations.map((a) => ({
      type: a.type,
      description: a.description,
    })),
    attempts,
  };
}

function mapOutcome(
  test: TestCase,
  lastResult: TestResult | undefined,
): "passed" | "failed" | "flaky" | "skipped" | "timedout" {
  const outcome = test.outcome();
  switch (outcome) {
    case "expected":
      return "passed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    case "unexpected":
      return lastResult?.status === "timedOut" ? "timedout" : "failed";
    default:
      return "failed";
  }
}

function shouldCollectArtifacts(mode: ArtifactMode, test: TestCase): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  // `failed` mode: upload for failed or flaky tests.
  const outcome = test.outcome();
  return outcome === "unexpected" || outcome === "flaky";
}

function mapFullResultStatus(
  status: FullResult["status"],
): "passed" | "failed" | "timedout" | "interrupted" {
  switch (status) {
    case "passed":
      return "passed";
    case "timedout":
      return "timedout";
    case "interrupted":
      return "interrupted";
    case "failed":
    default:
      return "failed";
  }
}
