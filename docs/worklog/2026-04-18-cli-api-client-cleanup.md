# 2026-04-18 — CLI api-client: replace type-assertion workarounds

## What changed

Removed two `as unknown as ...` casts (plus their `oxlint-disable` pragmas) from `packages/cli/src/lib/api-client.ts` with idiomatic alternatives.

## Details

| Location                | Before                                                                                                           | After                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `register()` response   | `Array.isArray(body.uploads)` + `body.uploads as unknown as RegisterArtifactUpload[]`                            | Zod `RegisterResponseSchema.safeParse(body)` — validates each element's shape.                                       |
| `uploadArtifact()` body | `Readable.toWeb(createReadStream(path)) as unknown as BodyInit` + `{ duplex: "half" } as unknown as RequestInit` | `await openAsBlob(localPath, { type: contentType })` — Blob is a native `BodyInit`, so no cast, no `duplex: "half"`. |

`RegisterArtifactUpload` is now derived via `z.infer` from the schema, keeping the public type and the runtime validator in sync.

## Code fixes / migrations

- `packages/cli/src/lib/api-client.ts` — both fixes above; dropped `createReadStream` / `Readable` imports.
- `packages/cli/package.json` — bumped `engines.node` `>=18` → `>=20` (`fs.openAsBlob` ships stable in Node 20).
- `packages/cli/tsdown.config.ts` — bumped `target` `node18` → `node20` to match engines.

## Verification

- `pnpm --filter @wrightful/cli typecheck` — pass.
- `pnpm --filter @wrightful/cli test` — 80/80 pass.
- `pnpm --filter @wrightful/cli build` — clean.
- `pnpm lint` — 0 warnings, 0 errors.
