# 2026-04-17 — Switch artifact storage to the native R2 binding

## What changed

Replaced R2's S3-compatible interface (signed PUT/GET URLs via `aws4fetch`) with the native R2 Worker binding (`env.R2.put` / `env.R2.get`). The `r2_buckets` binding was already declared in `wrangler.jsonc` but unused — this migration wires it up end-to-end and removes the S3 credentials, account id, and TTL config that existed only to drive `aws4fetch`.

The one-click "Deploy to Cloudflare" flow no longer needs a manual R2 token step. Only API-key seeding remains (the bootstrap CLI credential, unrelated to R2).

## API contract changes

- `POST /api/artifacts/presign` → `POST /api/artifacts/register`. Same input validation. Response drops `expiresAt`, renames `url` → `uploadUrl`, and returns a relative Wrightful path (`/api/artifacts/<id>/upload`) instead of a presigned R2 URL.
- **New** `PUT /api/artifacts/:id/upload` (authenticated, under the `/api` bearer-token prefix). Looks up the artifact, enforces the same project-ownership guardrail as register, validates `Content-Length` against the registered `sizeBytes`, streams `request.body` straight into `env.R2.put(key, body, { httpMetadata: { contentType } })`, returns 204.
- `GET /api/artifacts/:id/download` no longer redirects. It now streams bytes directly from `env.R2.get(key, { range: request.headers })`, forwards Range → 206 with `Content-Range`, supports HEAD via `env.R2.head`, and sets `Cache-Control: public, max-age=31536000, immutable` + CORS (`ACAO: *`, `ACAM: GET, HEAD, OPTIONS`, `ACAH: Range, If-Match, If-None-Match`). CORS is required because `trace.playwright.dev` fetches the zip cross-origin — the previous 302-to-R2 worked because R2's S3 endpoint defaults to `ACAO: *`; we now have to replicate it explicitly.

## Details

| Area                                                     | Change                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dashboard/src/lib/r2-presign.ts`               | **Deleted.** No more S3 signing.                                                                                                                                                                                                                             |
| `packages/dashboard/src/routes/api/artifacts.ts`         | `presignHandler` → `registerHandler`; no more `readR2Config` / `presignPut`; emits relative `uploadUrl`.                                                                                                                                                     |
| `packages/dashboard/src/routes/api/artifact-upload.ts`   | **New.** PUT handler; three-table ownership join; Content-Length check; `env.R2.put`.                                                                                                                                                                        |
| `packages/dashboard/src/routes/api/artifact-download.ts` | Rewrite: streams `env.R2.get`, Range forwarding, CORS headers, HEAD support, immutable cache.                                                                                                                                                                |
| `packages/dashboard/src/routes/api/schemas.ts`           | `PresignPayloadSchema` → `RegisterArtifactsPayloadSchema`.                                                                                                                                                                                                   |
| `packages/dashboard/src/worker.tsx`                      | Route renames; new `PUT /api/artifacts/:id/upload` under bearer-token prefix; download route now accepts GET + HEAD.                                                                                                                                         |
| `packages/dashboard/wrangler.jsonc`                      | Removed `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `WRIGHTFUL_PRESIGN_PUT_TTL_SECONDS`, `WRIGHTFUL_PRESIGN_GET_TTL_SECONDS` and the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secret comments. Kept `WRIGHTFUL_MAX_ARTIFACT_BYTES`. Added `limits.cpu_ms: 300000`. |
| `packages/dashboard/types/env.d.ts`                      | Removed matching var/secret declarations.                                                                                                                                                                                                                    |
| `packages/dashboard/worker-configuration.d.ts`           | Regenerated by `wrangler types`.                                                                                                                                                                                                                             |
| `packages/dashboard/.dev.vars.example`                   | Removed R2 S3 creds block.                                                                                                                                                                                                                                   |
| `packages/dashboard/package.json`                        | Removed `aws4fetch` dependency.                                                                                                                                                                                                                              |
| `packages/cli/src/lib/api-client.ts`                     | `presign` → `register`; response type drops `expiresAt` / renames to `uploadUrl`; `uploadArtifact` now resolves the relative uploadUrl against baseUrl and sends `Authorization: Bearer …` + `X-Wrightful-Version`.                                          |
| `packages/cli/src/commands/upload.ts`                    | Follows the renames; batch constant renamed to `REGISTER_BATCH_SIZE`.                                                                                                                                                                                        |
| `packages/e2e/vitest.globalSetup.ts`                     | Dropped `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` from `DEV_VARS` (miniflare provisions in-memory R2 from the binding).                                                                                                  |
| `packages/e2e/src/e2e.test.ts`                           | Old "Artifacts presign" block rewritten as end-to-end register → PUT upload → GET download (verifies bytes round-trip + CORS header).                                                                                                                        |
| `README.md`                                              | Deploy checklist collapsed from three steps to one (seed API key).                                                                                                                                                                                           |

## Design decisions

- **Two-step register/upload kept.** The CLI parallelises artifact uploads at 4-way; collapsing to a one-shot `POST /api/artifacts` would lose that. Register also remains the single place where project-ownership checks and size caps fail fast before the CLI opens the file handle.
- **No `artifacts.status` column added.** Row existence = "promised"; successful upload is inferred from the R2 object being present. A failed/partial upload leaves an orphan row whose download endpoint returns 404 — matches the existing v1 posture for `presign` + failed PUT. If we later need a "uploaded" signal (e.g. for a UI badge), add the column then.
- **Content-Type comes from the registered row**, not the request header. Downloads get predictable metadata regardless of what the CLI sent.
- **Size guard is defence-in-depth.** We require a matching `Content-Length` on upload, but the authoritative cap is already enforced at register. The upload check just stops mismatched streams before they hit R2.
- **`limits.cpu_ms: 300000`.** Streaming a 50 MiB body into R2 is almost entirely I/O, but slow clients can still run CPU time up; the 5-minute ceiling is insurance. Paid plan only — Free plans ignore the setting, so self-hosters on Free may want to lower `WRIGHTFUL_MAX_ARTIFACT_BYTES`.
- **Download endpoint stays unauthenticated, gated by unguessable ULID.** Unchanged from before. The previous `TODO(phase5)` for a signed-token challenge carries forward verbatim — flagged here as the security trust boundary shifts from "valid R2 signature" to "a valid ULID reaches our Worker", which is the same threat model (ULID leak = artifact leak) but now the bytes flow through our code rather than direct from R2.
- **CORS must be set explicitly.** trace.playwright.dev (and any other cross-origin consumer) was relying on R2's default `ACAO: *`. After this change we own the response headers, so we set `*` explicitly on the download handler.

## Verification

- `pnpm typecheck` — clean (cli + dashboard).
- `pnpm test` — 83 cli tests + 52 dashboard tests pass (including the new `artifact-upload.test.ts`, rewritten `artifacts.test.ts`, rewritten `artifact-download.test.ts`, renamed CLI `register` suite).
- `pnpm format:fix` — applied (only formatting adjustments to the handler + e2e file).
- `pnpm lint` — no new warnings from this change; pre-existing sidebar.tsx warnings unchanged.
- `pnpm --filter @wrightful/dashboard exec wrangler types --include-runtime false` — regenerated; `R2_ACCOUNT_ID` and friends are gone from `worker-configuration.d.ts`.
- E2E (`pnpm test:e2e`) should cover the register → PUT → GET round-trip against miniflare's in-memory R2.

**Manual smoke still TODO** after deploy: push a run with a real trace artifact, open the test detail page, click the trace viewer link, and confirm `trace.playwright.dev` can fetch the zip (tests the CORS header + Range support in production).
