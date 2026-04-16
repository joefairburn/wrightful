# 2026-04-16 — e2e: replace stale presign placeholder with real integration test

## What changed

Test 9 of the e2e harness (`packages/e2e/scripts/run-e2e.js`) was a placeholder
from when `/api/artifacts/presign` was unimplemented — it asserted a 501
response. The endpoint has since shipped (M1 artifact upload) and now validates
payloads + signs R2 URLs, so the assertion was failing.

Replaced the single 501 assertion with a real end-to-end integration against
the implemented endpoint:

- **9a** — Empty body still returns 400 (validation guard).
- **9b** — Pull a real `runId` + `testResultId` from D1 via
  `wrangler d1 execute --json` after Test 6's CLI upload, POST a valid payload,
  assert 201 + well-formed response (`uploads[].url` is a signed https URL,
  `r2Key` follows `runs/<runId>/<testResultId>/<artifactId>/<name>`,
  `artifactId` + `expiresAt` present).
- **9c** — Query the `artifacts` table and assert the row was eagerly inserted
  (documented contract: row existence == artifact was promised).
- **9d** — Submitting a `testResultId` with a bogus `runId` returns 400
  (ownership check).

## Details

| Change                          | Rationale                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write fake `.dev.vars` in setup | `readR2Config` throws (→500) if any of `R2_ACCOUNT_ID`/`R2_BUCKET_NAME`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are missing. Local dev has none of these by default. |
| Back up real `.dev.vars`        | If a developer has a real `.dev.vars`, we move it to `.dev.vars.e2e-backup` for the duration of the run and restore in `finally`.                                      |
| Fake-creds are safe             | Signatures built with `AKIAE2EFAKE`/`e2e-fake-secret` won't authenticate against R2, but the e2e only asserts response shape — it never PUTs to the signed URL.        |
| Renumber step log               | Added "Step 4: Write fake R2 creds", so "Run Playwright tests…" became Step 6 (was duplicated as Step 5).                                                              |

## Files changed

- `packages/e2e/scripts/run-e2e.js` — `.dev.vars` setup/teardown, Test 9 rewrite.

## Verification

```
pnpm --filter @greenroom/e2e test
# → 25 passed, 0 failed (was 15 passed, 1 failed)
pnpm lint
# → 5 pre-existing warnings, 0 errors
pnpm oxfmt --check .
# → All matched files use the correct format.
ls packages/dashboard/.dev.vars*
# → nothing (teardown restored cleanly)
```

## Ancillary

Also added `ignorePatterns: ["**/worker-configuration.d.ts"]` to `.oxfmtrc.json`
so the wrangler-generated ambient types file (committed in d573cc9) no longer
trips `pnpm oxfmt --check`.
