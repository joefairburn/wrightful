import type { IngestPayload, IngestResponse } from "../types.js";

const PROTOCOL_VERSION = 1;
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
          `CLI version incompatible with dashboard: ${body.error || "version mismatch"}`,
        );
      }
      throw new Error(
        `Upload failed (${response.status}): ${body.error || response.statusText}`,
      );
    }

    return body as unknown as IngestResponse;
  }
}
