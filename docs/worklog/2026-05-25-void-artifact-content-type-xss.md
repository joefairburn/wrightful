# 2026-05-25 — Artifact content-type XSS hardening

## What changed

Fixed a stored-XSS vector in the artifact download path (`packages/dashboard-void`).

`RegisterArtifactsPayloadSchema` was previously accepting `contentType` as `z.string().min(1)`. The value flowed through to R2's `httpMetadata.contentType` on upload, and was echoed back as the `Content-Type` response header by the download endpoint. The download endpoint is served from the dashboard's own origin and did not set `Content-Disposition: attachment`. An API-key holder could register an artifact with `contentType: "text/html"`, PUT an HTML/JS body, and share the signed download URL with a teammate — the browser would render the body as HTML on the dashboard origin and the script would inherit the victim's session cookie scope.

Two layers of defence applied so already-stored rows are also covered:

1. **Registration allowlist** (`src/lib/content-types.ts`, wired into `ArtifactRequestSchema`). Anything outside a known-safe MIME set is rejected at register time. `text/html`, `application/xhtml+xml`, `image/svg+xml`, `application/javascript`, and friends are explicitly out.
2. **Download-time normalisation** (`routes/api/artifacts/[id]/download.ts`). The served `Content-Type` is always passed through `safeContentType()` — anything unsafe is coerced to `application/octet-stream`, so legacy rows stored before this fix can't slip through. The response also carries `Content-Disposition: attachment; filename*=UTF-8''…` so a top-level navigation to a leaked signed URL downloads instead of renders. Subresource loads (`<img>`, `<video>`, `fetch()`, trace.playwright.dev) ignore Content-Disposition, so the dashboard's existing rendering paths keep working untouched.

The upload route was also updated to write the sanitised content-type into R2's `httpMetadata` (so any future direct read of the object — not just the dashboard's download endpoint — gets the safe value).

## Files touched

| File                                    | Change                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/lib/content-types.ts`              | New. `SAFE_CONTENT_TYPES` allowlist + `isSafeContentType()` / `safeContentType()` helpers.                         |
| `src/lib/schemas.ts`                    | `ArtifactRequestSchema.contentType` now `.refine(isSafeContentType, …)`.                                           |
| `routes/api/artifacts/register.ts`      | Unchanged in code — picks up new validation via the schema.                                                        |
| `routes/api/artifacts/[id]/upload.ts`   | R2 `httpMetadata.contentType` is now `safeContentType(row.contentType)`.                                           |
| `routes/api/artifacts/[id]/download.ts` | `buildHeaders` always overrides Content-Type via `safeContentType()` and sets `Content-Disposition: attachment`.   |
| `src/__tests__/content-types.test.ts`   | New. Allowlist + normalisation tests (case, parameters, denied types).                                             |
| `src/__tests__/schemas.test.ts`         | New describe block: schema rejects `text/html`, `image/svg+xml`, script types; accepts Playwright's emitted types. |

## Why two layers

The attack surface has two halves:

- **New artifacts** — fixed by the schema allowlist; hostile types now fail with `400` before they're stored.
- **Existing artifacts** — already-stored rows with unsafe `contentType` would still serve as `text/html` if only the schema was tightened. The download-time `safeContentType()` plus `Content-Disposition: attachment` covers this without a backfill migration.

`Content-Disposition: attachment` was chosen over a CSP because the trace viewer (`trace.playwright.dev`) cross-origin-fetches the artifact, and a CSP set on the artifact response wouldn't apply to that consumer. Attachment is honoured by all major browsers for top-level navigations and ignored for subresource loads — exactly the behaviour we want.

## Verification

```bash
pnpm --filter @wrightful/dashboard-void exec vp check src/__tests__/schemas.test.ts \
  src/__tests__/content-types.test.ts src/lib/content-types.ts src/lib/schemas.ts \
  routes/api/artifacts/register.ts routes/api/artifacts/[id]/download.ts \
  routes/api/artifacts/[id]/upload.ts
# → format pass, 0 errors. 1 pre-existing warning on register.ts:114 (`as never`) untouched.

pnpm --filter @wrightful/dashboard-void test
# → 7 test files, 91 tests pass (43 in the touched files).
```

Manual scenarios covered by the new tests:

- `contentType: "text/html"` → rejected by schema.
- `contentType: "image/svg+xml"` → rejected by schema.
- `contentType: "application/javascript" | "text/javascript" | "application/xhtml+xml"` → rejected.
- `safeContentType("text/html")` → `application/octet-stream` (download-time fallback for legacy rows).
- `safeContentType("IMAGE/PNG")` / `"image/png; charset=utf-8"` → normalised to `image/png`.
- All Playwright reporter-emitted types (`application/zip`, `image/png`, `image/jpeg`, `video/webm`, `video/mp4`, `text/plain`, `application/json`) — accepted.

In-app artifact rendering paths (`<img>`, `<video>`, the trace viewer link, "Copy prompt" `fetch().text()`) were re-read and confirmed to be unaffected by `Content-Disposition: attachment`.
