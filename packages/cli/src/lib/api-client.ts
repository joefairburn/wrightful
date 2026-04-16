import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { IngestPayload, IngestResponse } from "../types.js";

const PROTOCOL_VERSION = 2;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);

      // Don't retry client errors (except 429)
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }

      if (attempt === MAX_RETRIES) return response;

      const retryAfter = response.headers.get("Retry-After");
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.pow(2, attempt) * 1000;

      await sleep(delay);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }

  throw new Error("Retry exhausted");
}

export interface PresignArtifactRequest {
  testResultId: string;
  type: "trace" | "screenshot" | "video" | "other";
  name: string;
  contentType: string;
  sizeBytes: number;
}

export interface PresignUpload {
  artifactId: string;
  url: string;
  r2Key: string;
  expiresAt: string;
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "X-Greenroom-Version": String(PROTOCOL_VERSION),
    };
  }

  async ingest(payload: IngestPayload): Promise<IngestResponse> {
    const url = `${this.baseUrl}/api/ingest`;

    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    let body: Record<string, unknown>;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Upload failed (${response.status}): server returned non-JSON response`,
      );
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Authentication failed. Check your API key.");
      }
      if (response.status === 409) {
        throw new Error(
          `CLI version incompatible with dashboard: ${String(body.error) || "version mismatch"}`,
        );
      }
      throw new Error(
        `Upload failed (${response.status}): ${String(body.error) || response.statusText}`,
      );
    }

    const result: IngestResponse = {
      runId: String(body.runId),
      runUrl: String(body.runUrl),
    };
    if (typeof body.duplicate === "boolean") {
      result.duplicate = body.duplicate;
    }
    if (Array.isArray(body.results)) {
      result.results = body.results as IngestResponse["results"];
    }
    return result;
  }

  async presign(
    runId: string,
    artifacts: PresignArtifactRequest[],
  ): Promise<PresignUpload[]> {
    const url = `${this.baseUrl}/api/artifacts/presign`;
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ runId, artifacts }),
    });

    let body: Record<string, unknown>;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Presign failed (${response.status}): server returned non-JSON response`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Presign failed (${response.status}): ${String(body.error) || response.statusText}`,
      );
    }

    if (!Array.isArray(body.uploads)) {
      throw new Error("Presign response missing `uploads` array");
    }
    return body.uploads as PresignUpload[];
  }

  /**
   * Stream `localPath` to the presigned R2 URL via PUT. Does not use retry —
   * callers treat artifact upload as best-effort (test data is already persisted).
   */
  async uploadArtifact(
    presignedUrl: string,
    localPath: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<void> {
    const stream = createReadStream(localPath);
    const body = Readable.toWeb(stream) as unknown as BodyInit;

    const response = await fetch(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(sizeBytes),
      },
      body,
      // `duplex: 'half'` required by undici when streaming a Request body.
      // Not in the standard RequestInit type — cast through unknown.
      ...({ duplex: "half" } as unknown as RequestInit),
    });

    if (!response.ok) {
      throw new Error(
        `Artifact PUT failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}

/**
 * Run `tasks` with a maximum of `concurrency` in flight at once. Resolves
 * with each task's settled result so the caller can summarise failures.
 */
export async function runWithLimit<T>(
  concurrency: number,
  tasks: Array<() => Promise<T>>,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: Error }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: Error }> =
    new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        const value = await tasks[i]();
        results[i] = { ok: true, value };
      } catch (err) {
        results[i] = {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, tasks.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
