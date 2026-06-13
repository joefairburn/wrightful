import { z } from "zod";

/**
 * Validation contract for the flaky-test quarantine mutation. Shared by the
 * session-authed mutation route (`/api/t/:teamSlug/p/:projectSlug/quarantine`,
 * reused by both the flaky + tests-catalog pages) and unit tests.
 *
 * `testId` is the stable identity the reporter computes; `mode` is the v1
 * enforcement knob (`"skip"` demotes a quarantined failure to `skipped` on the
 * wire); `reason` is an optional human note. Sizes are bounded so a row can't
 * blow D1 limits.
 */

/** The two quarantine enforcement modes. `"skip"` is the v1 default. */
export const QUARANTINE_MODES = ["skip", "soft"] as const;
export type QuarantineMode = (typeof QUARANTINE_MODES)[number];

export const QUARANTINE_TEST_ID_MAX = 1024;
export const QUARANTINE_REASON_MAX = 1024;

/**
 * Body for quarantining a test. `reason` is optional: an empty/absent value
 * normalises to `null` so the column is consistently nullable.
 */
export const QuarantineTestSchema = z.object({
  testId: z.string().min(1).max(QUARANTINE_TEST_ID_MAX),
  mode: z.enum(QUARANTINE_MODES).default("skip"),
  reason: z
    .string()
    .max(QUARANTINE_REASON_MAX)
    .trim()
    .transform((s) => (s.length > 0 ? s : null))
    .nullable()
    .optional()
    .transform((s) => s ?? null),
});
export type QuarantineTestInput = z.infer<typeof QuarantineTestSchema>;

/** Body for un-quarantining a test — just the `testId` to remove. */
export const UnquarantineTestSchema = z.object({
  testId: z.string().min(1).max(QUARANTINE_TEST_ID_MAX),
});
export type UnquarantineTestInput = z.infer<typeof UnquarantineTestSchema>;
