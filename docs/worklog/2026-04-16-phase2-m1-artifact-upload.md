# 2026-04-16 — Phase 2 (M1): Artifact upload end-to-end

## What changed

Phase 2 Milestone 1 — the CLI can now collect Playwright attachments (traces, screenshots, videos) and stream them to Cloudflare R2 via presigned URLs. The dashboard mints presigned URLs, records artifact rows in D1 up front, and enforces a per-artifact size cap.

Three discrete pieces came together:

1. **Dashboard `/api/artifacts/presign`** swapped from a 501 stub to a real implementation that validates the request, confirms ownership of every `testResultId`, inserts artifact rows, and signs `PUT` URLs with `aws4fetch` (R2's S3-compatible endpoint).
2. **Protocol v2** — `/api/ingest` now echoes a `clientKey -> testResultId` mapping so the CLI can attach artifacts after the initial batch insert. The middleware accepts v1 requests unchanged (they simply miss out on the mapping) and v2 requests get the new field.
3. **CLI artifact pipeline** — the `artifact-collector` walks the Playwright JSON report's attachments, the `api-client` gained `presign()` and `uploadArtifact()` (undici streaming `PUT`), and the `upload` command wires the flow in as a best-effort step after ingest.

## Details

- **Dashboard dep:** added `aws4fetch@^1.0.20` (~6 KB, Workers-native).
- **Dashboard vars:** `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `GREENROOM_MAX_ARTIFACT_BYTES` (default 52428800), `GREENROOM_PRESIGN_PUT_TTL_SECONDS` (default 900), `GREENROOM_PRESIGN_GET_TTL_SECONDS` (default 600) in `wrangler.jsonc`.
- **Dashboard secrets:** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — set via `wrangler secret put` (see "R2 credential setup" below).
- **New file:** `packages/dashboard/src/lib/r2-presign.ts` — thin `AwsClient` wrapper exposing `presignPut` / `presignGet`.
- **Protocol:** `X-Greenroom-Version` range is now 1–2 (was 1). v2 adds `clientKey` on request results and `results: [{ clientKey, testResultId }]` on the response.
- **CLI dep:** none added. A tiny internal `runWithLimit` handles the 4-way concurrent `PUT` fan-out.
- **CLI behaviour:** `--artifacts` modes (`all`, `failed`, `none`) are now live. After a successful `ingest`, the CLI presigns up to 50 artifacts per call, streams files via `fetch` with `duplex: 'half'`, and logs per-file failures as warnings without failing the command.

## Files modified

- [packages/dashboard/package.json](../../packages/dashboard/package.json) — + `aws4fetch`
- [packages/dashboard/wrangler.jsonc](../../packages/dashboard/wrangler.jsonc) — R2 vars + secrets doc
- [packages/dashboard/src/lib/r2-presign.ts](../../packages/dashboard/src/lib/r2-presign.ts) — **new**
- [packages/dashboard/src/routes/api/artifacts.ts](../../packages/dashboard/src/routes/api/artifacts.ts) — presign handler implementation (size cap, cross-run validation, eager-insert)
- [packages/dashboard/src/routes/api/schemas.ts](../../packages/dashboard/src/routes/api/schemas.ts) — optional `clientKey` on each test result
- [packages/dashboard/src/routes/api/ingest.ts](../../packages/dashboard/src/routes/api/ingest.ts) — builds and returns `results` mapping
- [packages/dashboard/src/routes/api/middleware.ts](../../packages/dashboard/src/routes/api/middleware.ts) — max version bumped to 2
- [packages/dashboard/src/\_\_tests\_\_/artifacts.test.ts](../../packages/dashboard/src/__tests__/artifacts.test.ts) — **new** (5 tests)
- [packages/dashboard/src/\_\_tests\_\_/schemas.test.ts](../../packages/dashboard/src/__tests__/schemas.test.ts) — + `clientKey` cases
- [packages/dashboard/src/\_\_tests\_\_/middleware.test.ts](../../packages/dashboard/src/__tests__/middleware.test.ts) — v2 accepted
- [packages/cli/src/lib/artifact-collector.ts](../../packages/cli/src/lib/artifact-collector.ts) — real implementation
- [packages/cli/src/lib/api-client.ts](../../packages/cli/src/lib/api-client.ts) — `presign`, `uploadArtifact`, `runWithLimit`; bumped `X-Greenroom-Version` to `2`
- [packages/cli/src/lib/parser.ts](../../packages/cli/src/lib/parser.ts) — sets `clientKey: testId` on each result; exposes raw `report`
- [packages/cli/src/commands/upload.ts](../../packages/cli/src/commands/upload.ts) — wires the presign + PUT fan-out after ingest
- [packages/cli/src/types.ts](../../packages/cli/src/types.ts) — `clientKey` field + v2 `IngestResponse.results`
- [packages/cli/src/\_\_tests\_\_/artifact-collector.test.ts](../../packages/cli/src/__tests__/artifact-collector.test.ts) — **new** (12 tests)
- [packages/cli/src/\_\_tests\_\_/api-client.test.ts](../../packages/cli/src/__tests__/api-client.test.ts) — + presign + `runWithLimit` cases

## Design decisions

- **Eager-insert artifacts on presign, no confirm endpoint.** A successful presign returns with the row already written. If the follow-up `PUT` to R2 fails, the row is orphaned (a GET to `/api/artifacts/:id/download` will 404 on the R2 lookup). Accepted for v1; saves a round-trip. Rationale is explicit in [artifacts.ts:112–114](../../packages/dashboard/src/routes/api/artifacts.ts).
- **`clientKey === testId` today.** The schema carries a separate `clientKey` field so the correlation scheme can change later (e.g., per-retry artifacts) without breaking the wire format.
- **Unsigned Content-Type.** The presigned URL does not bind the `Content-Type` header — the CLI declares it via a plain header on the `PUT`. R2 accepts this; signing Content-Type would force the CLI to match it byte-for-byte which adds fragility.
- **Trace viewer: link-out for now, self-hosted later.** The download endpoint and test detail page come in M2. When they do, the trace-viewer integration will be a link to `trace.playwright.dev?trace=<presigned GET URL>`. A self-hosted trace-viewer component is deferred to Phase 5 (tracked as TODO in the plan file).
- **No `p-limit` dep.** A 10-line internal `runWithLimit` is enough for the one place we need bounded concurrency. Keeps the CLI's surface small.

## Backwards compatibility

The version negotiator accepts both v1 and v2. A CLI still sending `X-Greenroom-Version: 1` will continue to work — the response simply won't include the `results` mapping, so artifact upload will degrade to a clear warning ("server did not return a clientKey → testResultId mapping"). We will drop v1 support once a v2 CLI is published.

## R2 credential setup (for self-hosters)

The presigned URL flow needs R2 API credentials. These live as Worker secrets, not checked into the repo.

```bash
# 1. In the Cloudflare dashboard: R2 → Manage API Tokens → Create API Token
#    Permissions: Object Read & Write, scoped to the greenroom-artifacts bucket.

# 2. Set secrets on the deployed Worker:
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY

# 3. Set the account id var (non-secret):
#    Edit wrangler.jsonc → vars.R2_ACCOUNT_ID to your Cloudflare account id.
```

If any of the four are missing, the presign endpoint responds `500` with a clear error listing exactly which variables are unset — intentional so self-hosters see the problem immediately.

## Verification

- `pnpm typecheck` — clean across both packages.
- `npx oxfmt --check .` — clean (5 files re-formatted during implementation).
- `npx oxlint` — 0 errors, 4 warnings (all `no-unsafe-type-assertion` on intentional casts at the `fetch` streaming boundary / env access).
- `pnpm --filter @greenroom/cli test` — 83 tests passing (was 66 in Phase 1, +17 new in artifact-collector and api-client presign/runWithLimit coverage).
- `pnpm --filter @greenroom/dashboard test` — 34 tests passing (was 29 in Phase 1, +5 new in artifacts handler coverage).

Manual end-to-end validation against a live R2 bucket is deliberately deferred to after M2 so we can exercise the full upload-view-download loop (download endpoint arrives in M2).

## Risks carried forward

- **aws4fetch + R2 edge cases.** No real-R2 integration test yet; added unit coverage of the handler around a mocked signer. An opt-in integration test (gated on `GREENROOM_E2E_R2=1`) is worth adding before the first real deployment.
- **Protocol v1 deprecation.** Need to decide a cut-off after first public CLI release.
