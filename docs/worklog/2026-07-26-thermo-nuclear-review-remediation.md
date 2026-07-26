# 2026-07-26 — Thermo-nuclear review remediation

## Why

A deep maintainability audit of the `run-loading-indicator` branch found four
blocking problems behind an otherwise good set of decompositions. Two were real
defects, two were places where the branch's own safety claims were not actually
enforced.

The headline: the ingest split looked like a large simplification (2,151 lines →
1,362 across five modules) but the code count barely moved — **1,263 → 1,262
code lines, 791 → 18 comment lines**. The reduction was almost entirely deleted
rationale, and three invariants lost the only thing protecting them.

## What changed

### Lock ordering (defect)

`team-lock.ts` states that the team key-share lock must precede "any project,
invite, group, or **membership** lock". Every team-child mutator honoured it
except `members-repo.ts` — and that is the one the branch had just given a
_second_ child-table write (`removeTeamGroupLinks`). It therefore held
`memberships` rows while acquiring `memberGroupMembers` rows, while team
teardown's cascade takes those in the opposite order (`memberGroups` →
`memberGroupMembers` before `memberships`, per constraint-creation order). That
is a genuine 40P01 cycle, new in the same PR that authored the lock module.
Pre-PR it was impossible: the function locked one table, so it could be waited
on but could never wait.

- `setMemberRole`, `removeMemberGuarded`, and `leaveTeamGuarded` now open with
  `lockTeamForChildMutation`. A lost lock maps to each function's existing
  "already gone" outcome, so observable behaviour is unchanged: the team is gone,
  therefore the membership cascaded with it, which is exactly what a zero-row
  write already reported.
- New Postgres regression in `team-lock-order.test.ts` proves the cycle is
  broken: with teardown holding the parent, the removal parks at `teams` and
  holds _neither_ child row, so a `for update nowait` on both still succeeds.
  Verified by mutation — removing the lock makes it fail.
- The invariant is now recorded in `AGENTS.md`, which never mentioned it.

Note: the 7-line deadlock-ordering proof in `member-groups.ts:replaceMembers` was
NOT removed. Key-share locks do not conflict with each other, so two sibling
child mutations can both hold the parent and still race on `memberships` rows —
that comment is still load-bearing.

### Ingest module boundaries

`ingest.ts` was five bare `export *`, which widened the pipeline's public API
from 42 to 51 symbols and made nine deliberately-private helpers reachable from
any route. It now re-exports an explicit **9-symbol** production surface; tests
import the submodule directly, so "this test pokes at internals" is visible at
the import site.

`primitives.ts` (542 lines, seven unrelated concerns) is dissolved:

- Postgres chunking → new `src/lib/db/chunk.ts`, beside `db/batch.ts`. This is
  what forced `retention.ts`, `groups-page.ts` and `results-page.ts` to import
  the entire ingest graph — realtime publish, owners-repo, usage — to get a chunk
  size. All three now import no ingest code at all.
- `STATUS_BUCKET_MEMBERS` / `statusBucket` → `src/lib/status-buckets.ts`, the
  module whose own doc-comment already designated it the single home for the
  taxonomy. `statusBucket` returns `StatusGroupKey | null` rather than
  `keyof AggregateDelta`, which is both more precise and keeps that module
  dependency-free as documented. The two reverse-index builds there were
  near-duplicates and now share one `reverseIndex` helper.
- `statusMatchSql` **deleted**. It interpolated statuses into `sql.raw` with
  hand-quoting; its only justification (D1 bound-param text affinity) died with
  D1 and its safety comment was lost in the move. All six call sites use
  `inArray(testResults.status, …)` — the idiom already in use one line away in
  `results-page.ts`.
- `maybeUpdateCodeowners` → `lifecycle.ts`, its only caller, now module-private.
- `statementChangedRows = changedRows` (a pure identity alias) and the dead
  `_existingIds` parameter deleted.
- The remainder is renamed `write-and-publish.ts` — statement builders plus the
  commit-then-publish tail — because that is a responsibility you can state in
  one sentence and "primitives" was not.

`countMonitors`' `type` parameter was dead (cap enforcement moved into
`createMonitor`'s transaction) and was also the branch that bypassed
`childProjectScopeWhere` for a raw `eq`. Removed.

### Guards that were not actually guarded

- `artifacts-pipeline.test.ts` stubbed `.for()` as a hardcoded non-empty row,
  which made **both** fail-closed guards in `finalizeUploads` permanently true —
  the `runNotFound` path the previous worklog headlines was unreachable, and
  deleting either `return null` kept the suite green. `.for()` is now a chaining
  lock modifier like `.where`, drawing from the same FIFO. Two negative tests
  cover team-gone and project-gone, each asserting the signer was never called.
  The team-gone case deliberately supplies a _live_ project afterwards, without
  which the project guard masks the team guard and the test proves nothing.
- The 409 terminal-idempotency contract had zero tests in the file this branch
  created to test that route. Added two, including that the conflict takes
  precedence over the soft-limit warning header.

All four new guard tests were mutation-verified: each fails when its guard is
removed.

### Documentation that contradicted the code

Three docs asserted the opposite of what ships, all in files `AGENTS.md`
designates authoritative:

- `db/schema.ts` claimed the `team.delete` audit row "is still captured …
  awaited SYNCHRONOUSLY before the delete batch". That write was removed. It now
  explains why team deletion is deliberately unaudited (a pre-delete row cascades
  away on success and _survives a failed teardown_, recording a deletion that
  never happened).
- `audit.ts` mandated calling `recordAudit` before the delete statement. No
  caller does; a contributor following it would reintroduce the bug this branch
  fixed. It now documents the `buildAuditRow`-inside-the-transaction pattern.
- `env.ts` credited the monitor caps to a "TYPE-SCOPED `countMonitors`" that no
  longer exists.
- `AUDIT_ACTIONS.TEAM_DELETE` had zero production writers; removed with its UI
  label.
- `AGENTS.md` and `ARCHITECTURE.md` still named `src/lib/ingest.ts` as the
  pipeline's home, so an agent following the guardrail would add pipeline code to
  what is now a re-export file.

Restored rationale at the three unguarded invariants: the catalog-upsert sort
(a global lock ordering preventing AB/BA deadlock, explicitly _not_
`localeCompare`), the deliberate non-metering of testResults usage (metering it
serialized every concurrent `/results` flush across a whole team on one row), and
`resultUpsertSet`'s insert-only `createdAt`. Also the `?edit=1` defence on the
monitor page and the shard-2 note in the e2e suite.

### pg-integration parallelism made structural

Running `src/__tests__/pg-integration/` against a real database is only safe
serially: the files share one database and each `resetTables` drops and recreates
its tables, so a concurrent run lets one file drop a table another is asserting
on. It fails different tests each time — a forced-parallel run here produced 4
failures then 17.

This was already known and documented (`harness.ts`, and `ci.yml` passes
`--no-file-parallelism`), but it was held up entirely by remembering a flag on
one command line. A plain `pnpm test` with `PG_TEST_URL` set was silently flaky,
which is how it was rediscovered.

`vite.config.ts` now derives it: `fileParallelism: !process.env.PG_TEST_URL` —
the same variable that selects the shared database also serializes the lane, so
every invocation is correct by default. The pglite lane (each file its own
in-process instance) still runs fully parallel and is unaffected. CI's flag stays
as redundant reinforcement. Verified both directions: unflagged runs now pass
110/110 repeatedly, and forcing `fileParallelism: true` reproduces the flakiness.

### pg-integration can no longer wipe a real database

`buildHarness()` accepted whatever `PG_TEST_URL` pointed at, and `resetTables`
runs `DROP TABLE … CASCADE` on every table a suite touches. Pointing it at a
database that mattered destroyed it — and nothing complained, because dropping
tables is the harness's normal behaviour.

The failure mode was the bad one. Demonstrated against a stand-in
`wrightful_prod` holding one row: the unguarded run reported **3 tests passed**
while taking that table from 1 row to 0. A green suite that silently wiped a
database.

`assertDisposableTestDatabase` now rejects any `PG_TEST_URL` whose database name
is not `test` or `*_test`, before a connection is opened. Host is deliberately
not checked: CI service containers use assorted hostnames, so a localhost rule
would reject legitimate setups while still permitting the dangerous case of a
production database that happens to run locally. There is no opt-out, because an
escape hatch for "drop every table here" is exactly what ends up exported in a
shell profile.

Only the destructive lane is guarded. The `workers-db` lane also reads
`DATABASE_URL` and `.env.local`, but it is read-only (`select 1`,
`select count(*) from (values …)`) and never touches real tables, so guarding it
would break the documented dev workflow for no safety gain.

Covered by `src/__tests__/pg-test-url-guard.test.ts` (15 cases, including the
exact URL CI uses), and verified end-to-end in both directions.

## Verification

Postgres 17 was installed and run locally, so the `pg-integration` suites
actually executed rather than skipping — the previous worklog notes they could
not run in that sandbox.

- `pnpm check`: **0 errors**, 148 warnings — the same warning count as
  `origin/main`.
- Dashboard workers: 1,409 passed. Dashboard node: 736 passed, 4 skipped
  (against real Postgres; serialization is now automatic). Reporter: 326 passed.
- Mutation-tested: the members-repo parent lock (5 unit failures + the Postgres
  regression), both `finalizeUploads` guards, and the 409 branch.

**Not run:** the Playwright dashboard suite and the full-stack E2E harness.
