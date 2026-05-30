# 2026-05-30 — Artifact pipeline: a deep R2 key / token / download-response module

Cluster: **artifact-pipeline** (commit type `refactor`). Findings F24, F68, F27,
F28, F25, F29, F26, F93. Two of these (F27, F28) also have standalone detail
worklogs in this directory; this entry is the cluster-level summary that ties the
whole artifact-storage seam together.

## What changed

The artifact storage path — register row, upload bytes, sign a download URL,
stream the download/HEAD response — was previously smeared across four route
handlers (`routes/api/artifacts/{register,[id]/upload,[id]/download}.ts`), the
test-detail page, and a server action, each re-deriving the same R2 key shape,
idempotency rule, size-cap, and HTTP-protocol math inline. This cluster
concentrates that behaviour behind two small modules so the routes become
auth + translation only, mirroring the existing `src/lib/ingest.ts` split for
runs.

- **`apps/dashboard/src/lib/artifacts.ts` (new) — the storage seam.** Owns the
  artifact WRITE pipeline (`registerArtifacts`, `storeArtifactUpload`) and the
  READ pipeline (`readArtifact` + the pure `buildArtifactResponse` /
  `buildArtifactHeaders`). The route handlers now only authenticate, translate
  the discriminated result to an HTTP status, and shuttle bytes. Pure pieces are
  lifted and individually exported for unit testing: `safeKeySegment`,
  `artifactIdentity`, `buildArtifactR2Key`, `filenameFromKey`,
  `findOversizedArtifact`, and `planArtifactRegistration` (the pure
  fetched-rows → rows-to-insert + upload-URLs planning step, mirroring
  `computeAggregateDelta` for runs).
- **`apps/dashboard/src/lib/artifact-tokens.ts` — the download-URL shape.** Added
  pure, exported `signedDownloadHref(artifactId, token)` and
  `signedTraceViewerUrl(origin, artifactId, token)` so the
  `/api/artifacts/:id/download?t=…` literal and the trace-viewer wrap live in one
  place, consumed by both the server action (`test-artifact-actions.ts`) and the
  test-detail page island instead of being re-spelled at each call site.
- **DB-enforced idempotency.** The artifact idempotency identity is now a unique
  index (`artifacts_identity_uq`) on
  `(projectId, testResultId, type, name, attempt, COALESCE(role, ''))`, the DB
  mirror of `artifactIdentity()`. A retried `/results` flush reuses the existing
  row + R2 key instead of double-billing storage/egress, and the constraint
  closes the lookup-before-insert race the application dedupe alone could not.
- **Interface-truth fixes.** The pipeline was described in docs and inline
  comments as using "presigned R2 URLs"; in fact bytes traverse the worker
  (`storage.put` in `storeArtifactUpload`), so the upload URL is a relative
  worker route. The narration was corrected across CLAUDE.md, ARCHITECTURE.md,
  PRD.md, the reporter README/client, and the seam's own doc comments (F26). The
  `WRIGHTFUL_MAX_ARTIFACT_BYTES` env doc was corrected to state the cap binds in
  exactly one place — `register.ts` — and is only transitively enforced at upload
  via the size-match check (F93).

## Details

| Finding | Outcome     | Essence                                                                                                                                                             |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F24     | implemented | Created `src/lib/artifacts.ts` write-pipeline seam; routed `register.ts` + `[id]/upload.ts` through `registerArtifacts` / `storeArtifactUpload`.                    |
| F68     | partial     | Mostly delivered by F24 (exported + unit-tested `safeKeySegment`, `artifactIdentity`, `buildArtifactR2Key`, `findOversizedArtifact`).                               |
| F27     | implemented | DB-enforced idempotency: new `artifacts_identity_uq` unique index + matching migration; see `2026-05-30-f27-artifact-idempotency-index.md`.                         |
| F28     | implemented | Paired the R2-key constructor with its reverse (`filenameFromKey`); see `2026-05-30-f28-artifact-key-reverse-seam.md`.                                              |
| F25     | implemented | `signedDownloadHref` / `signedTraceViewerUrl` concentrate the download-URL + trace-viewer literals across the action, page island, and (by contract) the e2e suite. |
| F29     | implemented | Lifted the range / 304 / 206 / header protocol math off the Cloudflare `R2Object` into the pure `buildArtifactResponse`; `readArtifact` is the thin R2 adapter.     |
| F26     | implemented | Corrected the "presigned R2 URL" narration to "bytes traverse the worker" across docs, reporter, and seam comments.                                                 |
| F93     | implemented | `env.ts` doc-comment now states `WRIGHTFUL_MAX_ARTIFACT_BYTES` binds in exactly one place (`register.ts`).                                                          |

### Schema / migration

New Drizzle migration `20260530172125_deep_next_avengers.sql` adds the
`artifacts_identity_uq` unique index (with its `meta/` snapshot + `_journal.json`
entry). Applied on deploy per the no-edit-applied-migrations rule; the prior
`0000_init` and intervening migrations are untouched.

### Env

Added optional `ARTIFACT_TOKEN_SECRET` so the short-lived, broadly-minted,
HTML-embeddable artifact download tokens can be rotated independently of the
session-signing `BETTER_AUTH_SECRET`. Falls back to `BETTER_AUTH_SECRET` when
unset (backward compatible) in `artifact-tokens.ts#getKey`.

### Tests (new / extended)

- `src/__tests__/artifacts-pipeline.test.ts` — `safeKeySegment` (traversal,
  control chars, length cap, fallback), `artifactIdentity` (role coalesce),
  `buildArtifactR2Key` ⇆ `filenameFromKey` round-trip, `findOversizedArtifact`
  boundary, and the `planArtifactRegistration` branch matrix (idempotent reuse,
  within-request de-dup, fresh inserts) with a pinned `mintId`.
- `src/__tests__/artifact-response.test.ts` — `buildArtifactResponse` /
  `buildArtifactHeaders` over HEAD → 200, served range → 206 + `Content-Range`,
  open-ended-range length default, conditional miss → 304, content-type override,
  RFC 5987 `filename*` header-injection safety, and CORS headers.
- `src/__tests__/artifact-tokens.test.ts` — extended with `signedDownloadHref` /
  `signedTraceViewerUrl` encoding cases.

## Verification

All four gates green:

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (`void prepare` +
  `tsgo --noEmit`, 0 errors).
- `pnpm --filter @wrightful/dashboard test` — 509 passed (42 files).
- `pnpm --filter @wrightful/reporter test` — 150 passed (11 files).
- `pnpm check` — 0 errors, 78 warnings (pre-existing `no-unsafe-type-assertion`).

### Integration gap (noted, not closed)

`registerArtifacts` / `storeArtifactUpload` / `readArtifact` touch live D1 / R2
and so are not unit-tested directly (the dashboard vitest setup aliases `void/db`
to a stub and there is no R2 binding). Coverage is on the extracted pure
functions; the D1/R2 round-trip is exercised by the e2e dogfood suite.
