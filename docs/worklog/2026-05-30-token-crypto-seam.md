# 2026-05-30 — token-crypto seam: one home for credential-bytes crypto

## What changed

The security-relevant byte/crypto idioms behind every token and key path were
re-derived — in _divergent_ forms — across four files:

- `sha256Hex` (SHA-256 → fixed-width lowercase hex) in `api-key.ts`,
  `invite-tokens.ts`, and the `keys.ts` route.
- base64url encode/decode in `artifact-tokens.ts` (with the loop-not-spread
  large-array guard) and a separate, spread-based mint in `keys.ts` /
  `invite-tokens.ts` that _lacked_ that guard.
- constant-time compare in two shapes: `timingSafeEqualHex` (char-wise, in
  `api-key.ts`) and `timingSafeEqual` over bytes (in `artifact-tokens.ts`).
- random-token minting in `keys.ts` (`wrf_`-prefixed) and `invite-tokens.ts`
  (unprefixed).

These are exactly the primitives where divergence is dangerous (a non-constant
compare, a non-fixed-width hex, a stack-overflowing encode). Concentrated them
behind one seam — `src/lib/token-crypto.ts` — so the invariants are asserted
once and the seam is a unit-test surface. (F84)

Separately, `validateApiKey` in `api-key.ts` was the whole ingest auth gate with
its _pure_ security decision (hash the raw key, constant-time match across
same-prefix candidates, reject a matched-but-revoked row) buried inline behind a
Hono `Context` + live D1 fetch — so none of the tricky branches (multiple
same-prefix candidates, the revoked gate, no-match) were reachable by a unit
test. Extracted that decision into `selectMatchingKey(candidates, rawKey)`,
leaving `validateApiKey` as a thin IO wrapper (Bearer parse → fetch by prefix →
delegate → `lastUsedAt` bump). (F66)

## Details

New module `apps/dashboard/src/lib/token-crypto.ts`:

| Export                             | Responsibility                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `sha256Hex(input)`                 | SHA-256 digest as fixed-width lowercase hex (64 chars; leading zeros preserved) |
| `base64urlEncode(bytes)`           | url-safe, unpadded; loop-built binary string (safe for large arrays)            |
| `base64urlDecode(str)`             | bytes or `null` on malformed input (callers treat a bad token as a rejection)   |
| `timingSafeEqualBytes(a, b)`       | the single constant-time loop; false on length mismatch                         |
| `timingSafeEqualHex(a, b)`         | decode both hex inputs to bytes, delegate to `timingSafeEqualBytes`             |
| `mintToken(byteLen=24, prefix="")` | CSPRNG bytes → base64url, optional literal prefix (`"wrf_"` for API keys)       |

`hexToBytes` is a private helper for `timingSafeEqualHex`.

`selectMatchingKey` was added as a named export of `api-key.ts` (IO-free; async
only because `sha256Hex` uses `crypto.subtle`).

### Behaviour notes

- `timingSafeEqualHex` now decodes hex → bytes before comparing, rather than the
  prior char-wise compare. For the only caller (`apiKeys.keyHash` vs a freshly
  computed `sha256Hex`) both inputs are always valid 64-char lowercase hex, so
  the match result is identical; the new form additionally rejects malformed/odd
  hex (tested) and routes every compare through the one constant-time loop.
- `mintToken(24, "wrf_")` reproduces the old `generateApiKey()` exactly (24
  CSPRNG bytes, `wrf_` prefix, url-safe unpadded). `mintToken()` reproduces the
  old `generateInviteToken()` (24 bytes, no prefix). The invite path now also
  inherits the loop-not-spread large-array guard for free.
- `verifyArtifactToken` now calls `timingSafeEqualBytes`; the early
  `if (!provided) return null` still narrows `base64urlDecode`'s null before the
  compare.

## Files

- `apps/dashboard/src/lib/token-crypto.ts` — new seam.
- `apps/dashboard/src/lib/api-key.ts` — extracted `selectMatchingKey`; dropped
  local `hashKey` + `timingSafeEqualHex`; imports from the seam.
- `apps/dashboard/src/lib/artifact-tokens.ts` — dropped local base64url +
  `timingSafeEqual`; imports `base64url*` + `timingSafeEqualBytes`.
- `apps/dashboard/src/lib/invite-tokens.ts` — `generateInviteToken`/
  `hashInviteToken` now delegate to `mintToken`/`sha256Hex`.
- `apps/dashboard/routes/api/teams/[teamSlug]/p/[projectSlug]/keys.ts` — dropped
  local `sha256Hex` + `generateApiKey`; uses `mintToken(24, "wrf_")` + `sha256Hex`.
- `apps/dashboard/src/__tests__/token-crypto.test.ts` — new; pins the seam
  invariants (round-trip, large-array, fixed-width hex, constant-time, prefix).
- `apps/dashboard/src/__tests__/api-key.test.ts` — new; covers
  `selectMatchingKey` branches (single match, same-prefix decoy, revoked gate,
  revoked-doesn't-fall-through-to-live, no match, empty set).

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — 0 errors.
- `pnpm --filter @wrightful/dashboard test` — 135/135 (was 113; +22 from the two
  new files).
- `pnpm --filter @wrightful/reporter test` — 136/136 (unchanged; not touched).
- `pnpm check` — 0 errors, 83 warnings (matches baseline).
- Integration gap (no real-D1 harness): `validateApiKey`'s IO — Bearer parse,
  `db.select().where(prefix)`, the `waitUntil` `lastUsedAt` bump — is exercised
  only by the live e2e, not unit tests. The extracted `selectMatchingKey` carries
  the security logic that _is_ unit-testable.
