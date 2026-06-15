# 2026-06-14 — Test ownership / CODEOWNERS (roadmap 2.3)

## What changed

Layered test ownership: a manual `testOwners` table (the source of truth) plus
a CODEOWNERS derivation matched against each test's `file`. Manual assignments
override CODEOWNERS. The reporter now reads the repo's CODEOWNERS off disk at
`onBegin` and ships it on the open-run payload; the dashboard upserts it onto
the project so ownership derivation always reflects the latest committed file.
Owners are surfaced as chips on the flaky page, with an owner-gated assign /
remove control, and a CODEOWNERS paste fallback lives in project settings.

This mirrors the 2.2 flaky-quarantine commit's patterns exactly: a `*-repo.ts`
data layer scoped by `TenantScope.projectId`, a `resolveTestOwners` page-badge
join folded into the flaky loader's existing `Promise.all`, owner-gating via
`resolveOwnerTenantApiScope`, and the reporter↔dashboard wire contract kept in
sync with the contract canary.

## Details

### Schema (`apps/dashboard/db/schema.ts`)

| Change                                             | Notes                                                                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testOwners` table                                 | `id` ULID PK, `projectId` FK → projects (`onDelete: cascade`), `testId`, `owner` (opaque label), `source` `$type<"manual"\|"codeowners">()`, `createdAt`. Unique `(projectId, testId, owner)` + index `(projectId, testId)`. |
| `projects.codeownersFile` (text, nullable)         | The stored CODEOWNERS contents.                                                                                                                                                                                              |
| `projects.codeownersUpdatedAt` (integer, nullable) | Epoch-seconds last set (ingest or manual paste).                                                                                                                                                                             |
| `export type TestOwner`                            | New select-type alias.                                                                                                                                                                                                       |

One additive migration generated via `vp exec void db generate`:
`db/migrations/20260613232610_odd_gorilla_man.sql`. Fully non-destructive — a
`CREATE TABLE testOwners`, two `CREATE INDEX`, and two
`ALTER TABLE projects ADD <nullable column>`. No drops/rewrites.

### Pure CODEOWNERS engine (`src/lib/codeowners.ts`)

No `void`/DB imports. `parseCodeowners(text)` (skips blanks/`#` comments,
preserves order, keeps no-owner unset rules) + `matchOwners(filePath, rules)`
implementing GitHub's **last-match-wins** gitignore-glob semantics: leading `/`
anchors to root; trailing `/` matches a dir and everything under it; `*` doesn't
cross `/`; `**` crosses segments; `?` is one non-`/` char; a bare name with no
slash floats to any depth; no-owner rule unsets; no match → `[]`. Path
normalization strips a leading `/` or `./` so it matches the reporter's relative
POSIX paths (`tests/checkout.spec.ts`).

### Read path (`src/lib/owners-repo.ts`, `src/lib/owner-schemas.ts`)

- `resolveTestOwners(scope, testIds)` → `Map<testId, OwnerEntry[]>` = union of
  manual rows (`source="manual"`) and CODEOWNERS-derived owners (each test's
  latest `testResults.file` matched against `projects.codeownersFile`), **manual
  wins per test** (`mergeOwners`, extracted pure for unit testing). Three
  project-scoped reads run in parallel.
- `assignOwner` (insert source="manual", `onConflictDoNothing` on the unique
  index), `removeOwner` (scoped delete), `setCodeownersFile`. All scoped by
  `projectId`.
- `owner-schemas.ts`: `AssignOwnerSchema` / `RemoveOwnerSchema` (owner label
  non-empty, length-capped) + `CODEOWNERS_FILE_MAX`.

### Wire (ingest is primary source)

- Reporter (`packages/reporter/src/codeowners-file.ts`): `readCodeowners(rootDir)`
  checks `.github/CODEOWNERS` → `CODEOWNERS` → `docs/CODEOWNERS` (first found
  wins), resolved against `config.rootDir` (falls back to cwd). Skips files
  > 64 KiB; never throws (missing/unreadable → `null`).
- Reporter `index.ts` `onBegin`: reads CODEOWNERS, then opens the run with an
  optional top-level `codeowners` field. **Subtle fix:** the open now waits one
  async fs tick, so it no longer fires synchronously in `onBegin`; a result-less
  suite (all-skipped/empty) never flushes and so never awaited the open via the
  batcher. Stored `this.openPromise` and `await` it in `onEnd` before `/complete`
  so the open is reliably awaited. (This is what the 3 initially-failing reporter
  lifecycle tests caught.)
- `OpenRunPayloadSchema` gained optional `codeowners` (`MAX.CODEOWNERS` = 64 KiB),
  mirrored on the reporter `types.ts` `OpenRunPayload`.
- `openRun` (`src/lib/ingest.ts`): `maybeUpdateCodeowners` upserts the file onto
  the project when the payload carries non-blank content — runs on both
  fresh-open and duplicate (re-run) paths, and never clobbers a manually-pasted
  file with an empty/absent one (`shouldUpdateCodeowners` is pure). Best-effort
  (logs, never fails the open).

### Mutation route (`routes/api/t/[teamSlug]/p/[projectSlug]/owners.ts`)

Session-authed, owner-gated, intent-discriminated POST (`assign` / `remove`) via
`resolveOwnerTenantApiScope`. Validates with the Zod schemas; surfaces failures
via `?ownerError=` redirect-then-banner — and the flaky loader **reads** that
param and the page **renders** it (the dead-error-channel mistake the 2.2 review
caught is avoided here).

### UI

- `src/components/owner-cell.tsx`: owner chips (manual → `secondary`, codeowners
  → `outline`, each with an `ActorAvatar` tile) + an owner-only assign input and
  a `×` remove affordance on each MANUAL chip (codeowners-derived chips can't be
  removed here — they come from the file). Plain `<form>` POSTs, isomorphic.
- `flaky.server.ts`: `resolveTestOwners` folded into the existing `Promise.all`;
  `ownersByTestId`, `canManageOwners`, `ownerError` threaded into props.
- `flaky.tsx` + `flaky-test-row.tsx`: the Owner column (widened 120→210px) now
  hosts the `OwnerCell` (it previously showed the last failure's actor, which
  isn't an owner); owner-error banner added next to the quarantine one.
- CODEOWNERS paste fallback landed on the **existing project-scoped settings
  page** (`pages/settings/teams/[teamSlug]/p/[projectSlug]/keys.server.ts` +
  `.tsx`) — owner-gated already via `requireOwnedProjectScope`. New
  `updateCodeowners` action + a `SettingsCard` textarea showing
  `codeownersUpdatedAt` (blank+save clears the file).

## Tests

- `src/__tests__/codeowners.test.ts` (21 cases) — the highest-value test:
  parsing, last-match-wins (incl. a later general rule overriding an earlier
  specific one), anchored vs floating, `*.ext`, `dir/`, `/root-only`, `**`
  recursion, no-owner unset, no-match → `[]`, path normalization, email owners.
- `src/__tests__/owners-repo.test.ts` — pure `mergeOwners` manual-wins/dedupe
  logic + cross-tenant scoping (void/db-stub idiom from `quarantine-repo.test.ts`):
  `assignOwner` conflict target, `removeOwner`/`setCodeownersFile` projectId
  binding, different-scope isolation.
- `packages/reporter/src/__tests__/codeowners-file.test.ts` — file location
  precedence, missing-file/oversize tolerance, null-rootDir fallback.
- Contract canary extended: an open-run payload with `codeowners` parses (value
  survives) and one without still parses (`undefined`).

## Verification

| Check                                              | Result                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm --filter @wrightful/dashboard run typecheck` | clean (exit 0)                                                        |
| `pnpm --filter @wrightful/reporter run typecheck`  | clean                                                                 |
| `vp exec void db generate`                         | one additive migration (see SQL above)                                |
| `pnpm --filter @wrightful/dashboard test`          | 937 passed (89 files)                                                 |
| `pnpm --filter @wrightful/reporter test`           | 257 passed (16 files)                                                 |
| `pnpm --filter @wrightful/dashboard run check`     | 0 errors, 54 warnings (all pre-existing, in github-checks/github-app) |
| `vp check --fix packages/reporter`                 | 0 errors, 10 pre-existing warnings                                    |

## Notes / decisions

- **CODEOWNERS paste UI** landed on the existing project settings page
  (`…/p/[projectSlug]/keys.*`), not a new settings area — matching "extend the
  existing project-scoped settings surface".
- **Manual-wins** is implemented per-test in `mergeOwners`: if a test has any
  manual owner, the manual set is used verbatim and CODEOWNERS is ignored for
  it; otherwise the CODEOWNERS-derived set is used.
- **CODEOWNERS is derived on the fly** (not materialized): `resolveTestOwners`
  parses `projects.codeownersFile` and matches per request. The
  `source = "codeowners"` enum value on `testOwners` is reserved for a future
  "materialize at ingest" pass; v1 never inserts those rows.
- **`codeowners` field placement** is top-level on the open-run payload (sibling
  of `idempotencyKey`), not inside `run`, so it can't accidentally leak into the
  `runs` row via `buildRunInsertValues` (which reads `payload.run.*`).
- The reporter open is now gated behind an async fs read; `onEnd` awaits
  `this.openPromise` so a result-less suite still opens + completes. This was the
  one non-obvious behavioral change (caught by existing reporter lifecycle tests).

## Adversarial review + fixes

Reviewed across six dimensions (glob-correctness, tenant-isolation,
wire-contract, manual-wins union, ingest-upsert, UI). The isolation,
wire-contract, union, and UI dimensions came back clean: every owners query is
`projectId`-scoped, the owners mutation route is owner-gated (404s non-owners),
the open-run `codeowners` field stays in TS/Zod sync with a green canary, and
the `ownerError`/`codeownersError` redirect channels are actually consumed
(flaky.tsx + keys.tsx render them — the 2.2 dead-channel bug was not repeated).
Two real findings were fixed:

- **CODEOWNERS glob: no-trailing-slash directory patterns now own their subtree
  (correctness, the headline-feature engine).** `matchOwners` previously matched
  an anchored directory path written without a trailing slash (e.g.
  `/apps/github`, `/frontend`) only EXACTLY, so files under it weren't matched —
  breaking GitHub's own documented unset-a-subdirectory example (`/apps/` then a
  no-owner `/apps/github`). `matchAnchored` now treats any pattern that resolves
  to a directory as owning everything nested under it (match exact OR any
  ancestor-dir prefix), while preserving GitHub's quirk that a trailing `/*`
  matches a single level only and does NOT recurse (`docs/*` ≠ `docs/sub/x`).
  Pinned with new tests (GitHub's unset example, `docs/*` non-recursion, anchored
  - floating subtree). All 25 codeowners cases pass.
- **Ingest no longer churns `codeownersUpdatedAt` (wasted writes + misleading
  timestamp).** The reporter re-sends the on-disk CODEOWNERS on every `onBegin`,
  and `maybeUpdateCodeowners` rewrote the row unconditionally — so a stable file
  bumped `codeownersUpdatedAt` (shown as "Last updated" in settings) to ~now on
  every CI run. It now reads the stored (trimmed) value first and skips both the
  write and the timestamp bump when unchanged.

Re-verified: dashboard typecheck clean, **941 tests pass** (89 files, +4 glob
cases), `vp check` 0 errors.
