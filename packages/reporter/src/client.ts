import { openAsBlob } from "node:fs";
import type {
  ArtifactRegistration,
  ArtifactUpload,
  CompleteRunPayload,
  OpenRunPayload,
  TestResultPayload,
} from "./types.js";

const PROTOCOL_VERSION = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const ARTIFACT_PUT_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface FetchOptions {
  /** Total attempts = maxRetries + 1. Defaults to 3 (retry twice). */
  maxRetries?: number;
  /** Per-attempt request timeout (ms). */
  timeoutMs?: number;
}

/**
 * Retries on network errors + 5xx + 429; never retries 4xx (auth/validation).
 * Each attempt gets its own AbortSignal timeout so a hung dashboard can't
 * wedge the reporter — important because onEnd runs before Playwright exits.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }
      if (attempt === maxRetries) return response;
      const retryAfter = response.headers.get("Retry-After");
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.pow(2, attempt) * 500;
      await sleep(delay);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(Math.pow(2, attempt) * 500);
    }
  }
  throw new Error("Retry exhausted");
}

function authHint(context: string, status: number): string {
  if (status === 401 || status === 403) {
    return (
      `${context} rejected (${status}) — is WRIGHTFUL_TOKEN set correctly? ` +
      `The dashboard couldn't authenticate the request.`
    );
  }
  return "";
}

export class StreamClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "X-Wrightful-Version": String(PROTOCOL_VERSION),
    };
  }

  async openRun(payload: OpenRunPayload): Promise<{ runId: string }> {
    const response = await fetchWithRetry(`${this.baseUrl}/api/runs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as {
      runId?: string;
      error?: string;
    };
    if (!response.ok || !body.runId) {
      const hint = authHint("openRun", response.status);
      if (hint) throw new AuthError(hint);
      throw new Error(
        `openRun failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
    return { runId: body.runId };
  }

  async appendResults(
    runId: string,
    results: TestResultPayload[],
  ): Promise<Array<{ clientKey: string; testResultId: string }>> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/api/runs/${runId}/results`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ results }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      results?: Array<{ clientKey: string; testResultId: string }>;
      error?: string;
    };
    if (!response.ok) {
      const hint = authHint("appendResults", response.status);
      if (hint) throw new AuthError(hint);
      throw new Error(
        `appendResults failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
    return body.results ?? [];
  }

  /**
   * completeRun is the last-chance signal that a run finished normally. We
   * retry more aggressively than other calls because failing here leaves the
   * run stuck at status='running' until the dashboard's watchdog sweeps it.
   */
  async completeRun(
    runId: string,
    status: CompleteRunPayload["status"],
    durationMs: number,
    options: FetchOptions = {},
  ): Promise<void> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/api/runs/${runId}/complete`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ status, durationMs }),
      },
      { maxRetries: 5, ...options },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        `completeRun failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
  }

  async registerArtifacts(
    runId: string,
    artifacts: ArtifactRegistration[],
  ): Promise<ArtifactUpload[]> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/api/artifacts/register`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ runId, artifacts }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      uploads?: ArtifactUpload[];
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        `registerArtifacts failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
    return body.uploads ?? [];
  }

  /**
   * Stream a local file to the presigned upload URL. Retries on 5xx/network
   * errors (each attempt capped at 120s — videos can take a moment). The
   * Blob is re-opened per attempt because a consumed stream can't be replayed.
   */
  async uploadArtifact(
    uploadUrl: string,
    localPath: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<void> {
    const resolved = new URL(uploadUrl, this.baseUrl).toString();
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "X-Wrightful-Version": String(PROTOCOL_VERSION),
      "Content-Length": String(sizeBytes),
    };

    const maxRetries = DEFAULT_MAX_RETRIES;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const body = await openAsBlob(localPath, { type: contentType });
        const response = await fetch(resolved, {
          method: "PUT",
          headers,
          body,
          signal: AbortSignal.timeout(ARTIFACT_PUT_TIMEOUT_MS),
        });
        if (response.ok) return;
        if (response.status < 500 && response.status !== 429) {
          throw new Error(
            `artifact PUT failed: ${response.status} ${response.statusText}`,
          );
        }
        if (attempt === maxRetries) {
          throw new Error(
            `artifact PUT failed: ${response.status} ${response.statusText}`,
          );
        }
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.pow(2, attempt) * 500;
        await sleep(delay);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxRetries) throw lastError;
        await sleep(Math.pow(2, attempt) * 500);
      }
    }
    throw lastError ?? new Error("artifact PUT: retry exhausted");
  }
}
