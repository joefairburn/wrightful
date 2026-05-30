# 2026-05-30 — Origin-safety: ansi XSS sanitizer tests & CSP nonce decision

Cluster slug `origin-safety` (commit type `test`). Findings F88, F89, F90 — pin
the dashboard's origin-safety contracts (the lone untrusted-text → HTML sink, the
inline-script that forces the CSP, and the artifact content-type allowlist) with
focused unit tests, and record the one decision (nonce-CSP restoration) that is
infeasible on Void rather than leaving it as silent tech debt.

## What changed

These three findings cover the dashboard's small set of "attacker-controlled bytes
that touch the origin" surfaces. None of them needed a new behavioural seam — the
deep modules (`ansiToHtml`, `buildArtifactHeaders`, `safeContentType`) already
existed from prior work. The deepening here is making each contract a **unit-test
surface** so a refactor that quietly reopens an injection fails loudly, plus
recording why CSP cannot be the second layer.

- **F88 — ansi XSS sink is pinned.** `ansiToHtml` in `src/lib/ansi.ts` is the
  dashboard's only untrusted-text → `dangerouslySetInnerHTML` sink: `test-error-alert.tsx`
  feeds attacker-controlled Playwright `errorMessage` / `errorStack` (writable by
  anyone with a project API key via ingest) straight into `__html`. New
  `src/__tests__/ansi.test.ts` pins the two-part safety contract that previously
  lived only in a comment — (a) `Anser.escapeForHtml` runs first so raw `& < > "`
  are neutralised, and (b) `use_classes:true` so SGR colours emit `class="ansi-*"`
  wrappers, never a `style=`/`on*=` attribute surface.

- **F89 — CSP nonce restoration recorded as infeasible.** The ansi-XSS half of this
  finding was already covered by sibling F88. The remaining CSP half was implemented
  via the "record the decision" path after verifying nonce-CSP restoration is **not**
  feasible on Void (the framework emits executable inline `<script>` blocks during SSR
  — deferred-prop resolution and the FOUC-killer — with no per-request nonce hook).
  The FOUC-killer inline script was extracted from `middleware/01.head.ts` into a
  documented `src/lib/theme-init-script.ts` module that records why `script-src`
  keeps `'unsafe-inline'` and what that means for the ansi sink (CSP is _not_ a
  backstop there — the ansi sanitiser is the sole guarantee). The full rationale is
  in `docs/worklog/2026-05-30-csp-unsafe-inline-recorded-decision.md`.

- **F90 — artifact content-type allowlist is the single source of truth + cross-checked.**
  `SAFE_CONTENT_TYPES` in `src/lib/content-types.ts` is now exported (as a
  `ReadonlySet`) and carries a doc comment that names both legs of the artifact
  origin-safety policy: the allowlist itself, and the download handler's forced
  `Content-Disposition: attachment` (`buildArtifactHeaders` in `src/lib/artifacts.ts`).
  New `src/__tests__/artifact-origin-safety.test.ts` ties the allowlist _to the
  response-building behaviour_: it sweeps the canonical set for any executable /
  renderable type, downgrades every hostile token content-type to
  `application/octet-stream`, and asserts attachment-disposition holds for hostile
  and safe types alike — so widening one leg without the other fails loudly.

## Details

| Change                                                             | File                                                             | Why                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| New `ansiToHtml` / `stripAnsi` XSS-contract tests                  | `src/__tests__/ansi.test.ts`                                     | Pin the escape-first + `use_classes` contract for the lone untrusted → `__html` sink.               |
| Extract FOUC-killer to documented module                           | `src/lib/theme-init-script.ts`                                   | One home for the inline script + the recorded `'unsafe-inline'` / ansi-sink consequence.            |
| Consume `themeInitScript` in head middleware                       | `middleware/01.head.ts`                                          | Inline script body now references the documented module instead of an opaque string literal.        |
| New FOUC-killer invariant tests                                    | `src/__tests__/theme-init-script.test.ts`                        | Pin try/catch, dark default, no `<` (can't close host `<script>`), no `src=`/`on*=`/`eval` surface. |
| Export `SAFE_CONTENT_TYPES` as `ReadonlySet` + two-leg doc comment | `src/lib/content-types.ts`                                       | Make the allowlist the testable single source of truth; cross-reference the disposition + CSP legs. |
| New allowlist↔response cross-check tests                           | `src/__tests__/artifact-origin-safety.test.ts`                   | Tie the allowlist to `buildArtifactHeaders` so the two origin-safety legs can't silently drift.     |
| Recorded-decision worklog (CSP nonce infeasible on Void)           | `docs/worklog/2026-05-30-csp-unsafe-inline-recorded-decision.md` | Record why `script-src 'unsafe-inline'` is load-bearing and what re-enables a nonce later.          |

## Scope note

Per-finding verifier corrections were honoured: F89's ansi half folded into F88,
and its CSP half is path (b) (record the decision) because path (a) (nonce
restoration) is infeasible on Void. F90 was narrowed to its substantive half —
exporting + documenting the allowlist and cross-checking it against the response
builder — since the ansi-XSS and CSP-nonce halves are owned by F88 and F89. No
behavioural code changed except the FOUC-killer extraction (byte-identical script
body) and the `SAFE_CONTENT_TYPES` visibility/type widening; this is a `test`
cluster.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (void prepare + tsgo, 0 errors).
- `pnpm --filter @wrightful/dashboard test` — 545 passed / 46 files.
- `pnpm --filter @wrightful/reporter test` — 176 passed / 13 files.
- `pnpm check` — 0 errors, 84 warnings (all pre-existing, none in cluster files;
  `vp check --fix` reformatted `ansi.test.ts` and the recorded-decision worklog).
