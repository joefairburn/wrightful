# 2026-07-16 — FK-child indexes, invite accept-race + GC, quarantine provenance

## Summary

Four fixes across the schema/invite/quarantine surface, plus focused tests for
the previously-untested invite/token seam.

## 1. Missing `runId` indexes on run-child FKs (MEDIUM)

Run-deletion cascades (`projects → runs → children`) were seq-scanning FK-child
tables per deleted run because `runId` was not a probeable index prefix.

- `monitorExecutions.runId` (`→ runs.id`, `set null`) had no index. Added
  `monitorExecutions_runId_idx` — **partial** (`WHERE runId IS NOT NULL`),
  mirroring `runs_monitorId_idx`: only browser executions carry a `runId`, so
  the http/tcp uptime hot path takes no write amplification.
- `runShards.runId` (`→ runs.id`, `cascade`) — its only index
  (`runShards_project_run_shard_idx`) leads with `projectId`, so `runId` was not
  a usable prefix for the cascade. Added `runShards_runId_idx` (non-partial —
  `runId` is `NOT NULL`).

**`userState.lastTeamId` / `lastProjectId` (tiny-impact analogs): DEFERRED.**
A partial `WHERE ... IS NOT NULL` index buys nothing here — after a user's first
navigation these columns are almost always non-null, so the index would carry
nearly every row and add write amplification to a HOT path (`userState` is
upserted on navigation) to speed up a RARE, already-cheap operation (a team /
project delete null-scanning a one-row-per-user table). Net-negative; documented
inline in `db/schema.ts` above the table.

### Migration

`db/migrations/20260717080140_clean_psynapse.sql` — two `CREATE INDEX`
statements. Left as **plain `CREATE INDEX`** (not `CONCURRENTLY`):

- The identical FK-child index on the largest table (`runs_monitorId_idx`,
  migration `20260704124312_moaning_xorn.sql`) is plain, and **no** committed
  migration in this repo uses `CONCURRENTLY`.
- Migrations are applied by `void db migrate` (drizzle-kit lineage), which wraps
  each file in a transaction; `CREATE INDEX CONCURRENTLY` is illegal inside a
  transaction, so switching would require an out-of-band apply path this repo
  doesn't have.

**Tradeoff:** plain `CREATE INDEX` takes a `SHARE` lock that blocks writes
(ingest) to `monitorExecutions` / `runShards` for the duration of the build on a
large table during deploy. `runShards` is small (one row per shard) and
`monitorExecutions` is moderate; the build should be brief. If either grows
large enough to matter, the index should be built manually with
`CREATE INDEX CONCURRENTLY` out-of-band and the migration marked as already
applied. (Pre-existing, unrelated: the GIN/trigram migrations also lack
`CONCURRENTLY` — noted, NOT rewritten.)

## 2. `acceptDirectedInvite` check-then-insert race (MEDIUM)

`src/lib/invites.ts`. Two problems, one rewrite:

- The membership-existence probe and the `runBatch` insert were separate, so
  concurrent accepts of two different invites to the same team both inserted and
  the loser hit `memberships_user_team_idx` (23505) as an unhandled 500.
- The invite was validated (`expiresAt > now`, addressee) in a SELECT **outside**
  the write transaction, so an invite revoked between SELECT and write still
  granted membership.

**Fix:** the outer SELECT is now only for the team slug + a friendly fast 404.
The authoritative validate-and-consume is a `DELETE ... RETURNING` inside the
same `db.transaction` as the membership insert (the members-repo
transaction-with-conditional-write idiom): the delete's WHERE re-checks expiry +
addressee and gates the insert, so a revoked/expired invite yields zero deleted
rows → no membership. The membership insert's 23505 is caught with the existing
`isUniqueViolation` helper and treated as an idempotent "already a member"
success (consuming the invite). Audit records only the genuine join.

## 3. Expired `teamInvites` never garbage-collected (LOW)

Reads filter `expiresAt > now` but nothing deleted expired rows, so the
token-hash-bearing table grew unbounded.

- Added `sweepExpiredInvites(now, limit)` to `src/lib/invites.ts`: deletes
  strictly `expiresAt < now`, bounded via `id IN (SELECT ... LIMIT n)` so a
  mass-expiry event stays within budget.
- Added cron `apps/dashboard/crons/sweep-invites.ts` (new file), cron expression
  **`15 4 * * *`** — distinct from all seven existing crons (`* * * * *`,
  `*/5 * * * *`, `2-59/5 * * * *`, `4-59/5 * * * *`, `0 */6 * * *`, `0 3 * * *`,
  `30 4 * * *`), which matters because Void dispatches via
  `switch (controller.cron)`. Thin adapter over `sweepExpiredInvites` wrapped in
  `loggedScheduled`, looping a bounded number of chunks per tick.

## 4. `quarantineTest` upsert clobbered `createdAt`/`createdBy` (LOW)

`src/lib/quarantine-repo.ts`. The `onConflictDoUpdate` set re-stamped
`createdBy`/`createdAt` on every edit, destroying the "quarantined since"
provenance that `listQuarantine` orders by. The update set now writes only the
mutable `reason`/`mode`; `createdAt`/`createdBy` are preserved. (The schema has
no `updatedAt`/`updatedBy` columns, so there is nothing else to touch.)

## Tests

- `src/__tests__/invite-tokens.workers.test.ts` (new, 8 tests): mint
  URL-safety/uniqueness, hash determinism (so a persisted hash matches on
  lookup), SHA-256 parity, distinct-token→distinct-hash, non-reversibility.
- `src/__tests__/pg-integration/invites.test.ts` (new, 6 tests, real pglite/
  node-postgres via the shared harness): happy-path accept; **idempotent accept**
  (pre-existing membership → 23505 caught → success, no duplicate, invite
  consumed); **in-transaction revoke guard** (invite deleted in the SELECT→write
  window via a `db.transaction` spy → no membership granted); expired-invite
  404; wrong-addressee 404; no-verified-email 403.
- `src/__tests__/quarantine-repo.workers.test.ts` (updated): the upsert-set
  assertion now pins that `createdBy`/`createdAt` are absent from the update set.

### Results

- Workers lane (`-c vitest.workers.config.ts`): invite-tokens + quarantine-repo
  = **14 passed**.
- Node lane (pg-integration): invites = **6 passed**.

Not run: repo-wide `pnpm check` / formatters / e2e (per task scope).
