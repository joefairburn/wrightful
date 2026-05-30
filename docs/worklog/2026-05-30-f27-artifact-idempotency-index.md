# 2026-05-30 — F27: enforce the artifact idempotency invariant with a DB unique index

## What changed

The artifact "natural identity" tuple — `(testResultId, type, name, attempt, role)` —
is the contract for idempotent re-registration: a retried `/results` flush re-sends
the same artifact set, and `artifactIdentity()` (in `src/lib/artifacts.ts`) collapses
duplicates so the reporter's PUT overwrites one R2 object instead of minting a duplicate
row and double-billing storage/egress.

Until now that invariant was enforced **only** by an application-side lookup-before-insert
in the register pipeline. There was no DB constraint backing it (the `artifacts` table had
just `artifacts_testResultId_idx`), so the rule was invisible to anyone reading the schema
and the lookup-before-insert left a race window open under concurrent retries.

This change makes the invariant **explicit and DB-enforced**:

1. Added a unique index `artifacts_identity_uq` on
   `(projectId, testResultId, type, name, attempt, COALESCE(role, ''))` to the `artifacts`
   table (new numbered migration `20260530172125_deep_next_avengers.sql`).
2. Co-located the keep-in-sync contract at both sites: a docstring on the index in
   `db/schema.ts` and on `artifactIdentity()` in `src/lib/artifacts.ts`, each pointing at
   the other.
3. Added migration-vs-identity unit tests asserting the index column set is exactly the
   `artifactIdentity` tuple (and excludes fields it ignores, e.g. `snapshotName`).

This is the F27 finding in its verifier-revised form. The original "lift `artifactIdentity`
into a shared module" framing was already delivered by sibling F24 (the helper is exported
and unit-tested); the verifier narrowed F27 to the real kernel — a latent-invariant /
robustness + locality issue, not a module-depth one.

## Details

| Item                | Value                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| New migration       | `db/migrations/20260530172125_deep_next_avengers.sql`                                                                  |
| New index           | `artifacts_identity_uq` UNIQUE on `(projectId, testResultId, type, name, attempt, COALESCE(role, ''))`                 |
| Schema import added | `import { sql } from "void/_db"` (for the COALESCE expression)                                                         |
| Tests added         | `artifact idempotency index ⇆ artifactIdentity` describe block (2 tests) in `src/__tests__/artifacts-pipeline.test.ts` |

### The `COALESCE(role, '')` detail (load-bearing)

`role` is nullable, and SQLite treats each `NULL` as **distinct** in a unique index. A plain
unique index over the raw `role` column would therefore _not_ dedupe role-less artifacts —
which is the common, non-visual-regression case — leaving the race window open exactly where
it matters most. `COALESCE(role, '')` collapses `NULL` to the empty string, mirroring
`artifactIdentity`'s `role ?? ""`, so the DB enforces the same identity the application
dedupes on.

### drizzle-kit emission caveat

`void db generate` produced the index but **mis-quoted** the expression, splitting it on the
comma into two bogus backtick-quoted "columns":
`(...,\`COALESCE("role"\`,\` '')\`)`. This is invalid DDL. The generated `.sql`was
hand-corrected to the valid form`(...,COALESCE("role", ''))`. The drizzle snapshot
(`meta/20260530172125_snapshot.json`) recorded the index correctly as a single
`COALESCE("role", '')`column, so a subsequent`void db generate` reports
"No schema changes" — no drift. A unit test guards against the bogus split form regressing.

## Code fixes / migrations

- `db/schema.ts` — added the unique index + `sql` import; rewrote the `snapshotName` comment
  (it falsely claimed a "partial index below" that never existed) to note it is **not** part
  of the identity.
- `src/lib/artifacts.ts` — expanded the `artifactIdentity` docstring to point at
  `artifacts_identity_uq` and document the keep-in-sync requirement.
- `db/migrations/20260530172125_deep_next_avengers.sql` — new migration, hand-corrected SQL.

The migration applies on `void deploy` (no separate migrate step). Per the durable decisions,
nothing has deployed against these schema files yet, so this is a fresh numbered migration,
not an edit of an applied one.

## Verification

- `npx void db generate` — produced the migration; re-running reports "No schema changes".
- Validated the corrected DDL against real SQLite 3.51: two `role IS NULL` rows with the same
  identity tuple → second insert fails with `UNIQUE constraint failed: artifacts_identity_uq`;
  rows with a distinct `role` or `name` are allowed. Dedup semantics match `artifactIdentity`
  exactly (final row count matched the application-level dedup).
- `pnpm --filter @wrightful/dashboard run typecheck` — passes (no circular-import issue from
  `void/_db`; codegen ready).
- `vp test run src/__tests__/artifacts-pipeline.test.ts` — 27 passed.
- `vp test run` (full dashboard suite) — 488 passed across 41 files.

### Integration gap

The dashboard vitest aliases `void/db` to a stub, so the index cannot be exercised through the
register pipeline in unit tests. The DB enforcement was instead validated directly against
SQLite (above), and the unit tests assert the migration's column set matches the identity
tuple. End-to-end enforcement of the constraint under real concurrent retries is left to the
e2e/dogfood path.
