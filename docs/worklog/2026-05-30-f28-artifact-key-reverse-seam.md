# 2026-05-30 — F28: pair the R2 key constructor with its filename-reversal (`filenameFromKey`)

## What changed

Closed the second half of the artifact R2-key seam. Sibling F24 already lifted
the key **constructor** (`buildArtifactR2Key`) and `safeKeySegment` into
`src/lib/artifacts.ts` and routed `register.ts` through it. But the **reverse** —
recovering the download filename from a key — was still hand-rolled inline in the
download handler as `r2Key.split("/").pop() ?? "artifact"`, with nothing tying it
to the construction convention.

F28 introduces the inverse function alongside the constructor so the
trailing-segment convention lives in one module:

- `filenameFromKey(key): string` — the sole reverse of `buildArtifactR2Key`,
  added to `src/lib/artifacts.ts` directly under the constructor.
- `routes/api/artifacts/[id]/download.ts` now calls `filenameFromKey(r2Key)`
  instead of interpolating `.split("/").pop()` inline.

The pairing is the point. The download hot path deliberately skips the DB — the
signed token (`artifact-tokens.ts`) carries only `{ r2Key, contentType, exp }`,
not the original `name` — so the served `Content-Disposition` filename depends
entirely on the "trailing segment is the sanitized filename" invariant. With
construct and reverse in one module, a future key-layout change (e.g. a date
partition for retention sweeps) edits `buildArtifactR2Key` and the colocated
round-trip test fails loudly instead of silently corrupting every download
filename.

## Details

| File                                                      | Change                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/artifacts.ts`                     | New exported `filenameFromKey(key)`; doc comment states the round-trip invariant.                                                                                                                       |
| `apps/dashboard/routes/api/artifacts/[id]/download.ts`    | Import + use `filenameFromKey`; dropped the inline `.split("/").pop()`.                                                                                                                                 |
| `apps/dashboard/src/__tests__/artifacts-pipeline.test.ts` | New `filenameFromKey ⇆ buildArtifactR2Key round-trip` describe: property `filenameFromKey(buildArtifactR2Key(..., name)) === safeKeySegment(name)` over several names + a degenerate-key fallback case. |

Left untouched per the verifier's narrowing of the original finding:

- `src/lib/test-artifact-actions.ts` — pure pass-through (SELECTs `r2Key`, hands
  it to `signArtifactToken`); never constructs or parses the key.
- `packages/e2e/src/e2e.test.ts` — the regex key-format assertion stays a
  black-box wire check; it does not import the dashboard seam.

## Behavioral note

The reverse changes `?? "artifact"` to `|| "artifact"`. For all real keys (which
always end in a non-empty `safeKeySegment`, itself falling back to `"artifact"`)
the result is identical. The `||` additionally guards the degenerate
empty-trailing-segment case (a trailing-slash / empty legacy key) that the old
`??` would have served as an empty filename — a strict improvement on an
edge that the constructor never produces.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (codegen + `tsgo --noEmit`, 0 errors).
- `vp test run src/__tests__/artifacts-pipeline.test.ts` — 29 passed (was 27; +2 round-trip).
