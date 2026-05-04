import { test, expect } from "@playwright/test";

const COUNT = Number(process.env.LOAD_TEST_COUNT ?? "1000");
const JITTER_MS = Number(process.env.LOAD_TEST_JITTER_MS ?? "0");

for (let i = 0; i < COUNT; i++) {
  test(`load test #${String(i).padStart(5, "0")}`, async () => {
    if (JITTER_MS > 0) {
      await new Promise((r) => setTimeout(r, Math.random() * JITTER_MS));
    }
    expect(i).toBeGreaterThanOrEqual(0);
  });
}
