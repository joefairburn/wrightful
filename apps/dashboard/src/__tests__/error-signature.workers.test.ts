import { describe, expect, it } from "vite-plus/test";
import {
  ERROR_SIGNATURE_MAX_CHARS,
  failureSignature,
  normalizeErrorSignature,
} from "@/lib/error-signature";

describe("normalizeErrorSignature", () => {
  it("strips ANSI and keeps the first meaningful Playwright assertion line", () => {
    expect(
      normalizeErrorSignature(
        "\u001b[31mError: expect(page).toHaveURL(expected) failed\u001b[39m\nExpected: /dashboard\nReceived: /login",
      ),
    ).toBe("expect(page).toHaveURL(expected) failed");
  });

  it("masks volatile durations, URLs, ids, source positions, strings, and numbers", () => {
    expect(
      normalizeErrorSignature(
        'Error: request 01ARZ3NDEKTSV4RRFFQ69G5FAV for "alice" timed out after 30000ms at /Users/dev/tests/login.spec.ts:42:7 via https://example.test/login?attempt=2',
      ),
    ).toBe(
      "request <id> for <value> timed out after <duration> at <path>:<line>:<col> via <url>",
    );
  });

  it("groups strict-mode errors without erasing the useful API name", () => {
    expect(
      normalizeErrorSignature(
        "Error: locator.click: strict mode violation: getByRole('button', { name: 'Save' }) resolved to 2 elements",
      ),
    ).toBe(
      "locator.click: strict mode violation: getByRole(<value>, { name: <value> }) resolved to <n> elements",
    );
  });

  it("preserves useful network error names while masking endpoint numbers", () => {
    expect(
      normalizeErrorSignature("Error: connect ECONNREFUSED 127.0.0.1:5432"),
    ).toBe("connect ECONNREFUSED <n>.<n>:<n>");
  });

  it("returns null for empty/stack-only input and caps long signatures", () => {
    expect(normalizeErrorSignature(null)).toBeNull();
    expect(
      normalizeErrorSignature("\n at tests/example.spec.ts:1:1"),
    ).toBeNull();
    expect(normalizeErrorSignature(`Error: ${"x".repeat(500)}`)).toHaveLength(
      ERROR_SIGNATURE_MAX_CHARS,
    );
  });
});

describe("failureSignature", () => {
  const message = "Error: expect(received).toBe(expected) failed";
  const stack =
    "Error: page.goto: net::ERR_CONNECTION_REFUSED\n  at nav.ts:1:1";

  it("fingerprints failed/timedout/flaky finals and nothing else", () => {
    for (const status of ["failed", "timedout", "flaky"]) {
      expect(failureSignature(status, message, null)).toBe(
        "expect(received).toBe(expected) failed",
      );
    }
    for (const status of ["passed", "skipped", "queued"]) {
      expect(failureSignature(status, message, null)).toBeNull();
    }
  });

  it("falls back to the stack when the message is blank — the errorHead rule", () => {
    expect(failureSignature("failed", "   ", stack)).toBe(
      "page.goto: net::ERR_CONNECTION_REFUSED",
    );
    expect(failureSignature("failed", null, stack)).toBe(
      "page.goto: net::ERR_CONNECTION_REFUSED",
    );
    // A non-blank message shadows the stack.
    expect(failureSignature("failed", message, stack)).toBe(
      "expect(received).toBe(expected) failed",
    );
    expect(failureSignature("failed", null, null)).toBeNull();
  });
});
