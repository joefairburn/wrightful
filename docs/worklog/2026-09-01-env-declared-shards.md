# Env-declared shard identity for self-slicing CI matrices

## What changed

`@wrightful/reporter` (minor): a matrix leg that slices the suite without
`--shard` can now declare `WRIGHTFUL_SHARD_INDEX` / `WRIGHTFUL_SHARD_TOTAL`.
`resolveShardIdentity` (`packages/reporter/src/ci.ts`) resolves coordinates
from `config.shard` when Playwright is sharding, else from the env pair
(both required, `1 <= index <= total`; malformed → warn + fall back to the
single-run shape). `onBegin` uses it in place of the inline `config.shard`
remap. No dashboard or wire change: `ShardSchema` and the `runShards`
machinery (hold at `running`, worst-status merge, per-shard
`expectedTotalTests`, per-test `shardIndex`) already handle these payloads.

`CIExecutionContext.nativeSharded: boolean` became
`shardSource: "none" | "cli" | "env"` — the flag now covers env-declared
shards, and the GitHub fail-closed rerun gate deliberately applies to them
too (the partial-rerun hazard is identical). Reporter warning/blocked strings
and the README were swept of "native shard" in favour of `--shard` /
"sharded" wording.

`resolveCIExecutionPolicy` gained two warnings for the halves of the pairing
used alone:

- Explicit `WRIGHTFUL_IDEMPOTENCY_KEY`, no shard coordinates, CI detected:
  legs sharing the key merge into a run that finalizes on the first leg's
  `/complete` and 409s the rest — silently and lossily. This is the exact
  failure a downstream fork (bumper) shipped for two months: 20 `--project`
  matrix legs sharing a key set to work around the pre-0.3.0 rerun collision,
  never removed after 0.3.0 folded the run attempt and project set into the
  derived key. Monitors never see this warning (`detectCI()` is null in the
  sandbox container).
- Env-declared coordinates, no explicit key: the derived key's project-set
  hash separates `--project` legs, so each opens its own run declaring the
  full total and hangs until the stale-run watchdog. Warn rather than block:
  same-project slicing (a grep) converges legitimately.

## Why

Playwright sets `config.shard` only under `--shard`, but `--shard` cannot
express heterogeneous legs (per-project workers/timeouts/serial constraints),
so real suites shard via a `--project` matrix instead. The wire has carried
`shard` since the beginning; only the reporter had no way to say it.

## Files

- `packages/reporter/src/ci.ts` — `resolveShardIdentity`, `ShardSource`,
  guards, reworded blocked/GitLab messages
- `packages/reporter/src/index.ts` — wiring, PR-comment skip message
- `packages/reporter/src/types.ts` — doc updates only (wire unchanged)
- `packages/reporter/README.md` — self-sharding matrix recipe
  (`$((JOB_INDEX + 1))`; Actions expressions have no arithmetic), shard
  vocabulary note, "remove pre-0.3.0 key workarounds", re-run-all-jobs
- Tests: `ci.test.ts` (resolution table + guard matrix),
  `reporter-identity.test.ts` (env shard reaches open/complete wire bodies;
  malformed declaration omits `shard` and warns), `reporter-test-support.ts`

Core resolution + suite/README seeds ported from fork PR
gitasf/bumper-playwright-dashboard#23; the `shardSource` rename and both
guards are new here.

## Post-review hardening (multi-agent review of the diff)

- `maybePostPrComment` now skips only when `shard.total > 1`: the dashboard
  treats a 1-of-1 declaration as an ordinary run (`expectedShards > 1` gate),
  so skipping there silently turned PR comments off with no aggregate to
  defer to. This also corrects the pre-existing `--shard=1/1` case.
- A malformed declaration alongside an explicit `WRIGHTFUL_IDEMPOTENCY_KEY`
  escalates its warning: the shardless fallback on a _shared_ run can finalize
  it early (legacy path if it completes first) or contribute no `runShards`
  row and strand the run for the watchdog — it is only a clean "whole run"
  when the leg isn't merged.
- The verbatim-key warning is suppressed for
  `WRIGHTFUL_RUN_ORIGIN=synthetic` rather than assuming monitors have no CI
  env (`detectCI` returns an "unknown" provider for any `CI=true` image). It
  still fires for single-job explicit keys on CI — conditional phrasing, by
  design; the reporter cannot observe key sharing.
- Shard coordinates are capped at int4 max: an oversized
  `WRIGHTFUL_SHARD_TOTAL` (e.g. wired to a run id) previously passed the wire
  schema and 500'd the `runs` insert, losing the run.
- Shard-declaration warning moved below the streaming-disabled guard; README
  recipe pins `shell: bash` and restores `github.job` to the shared key so
  two reporter-using matrix jobs in one workflow can't collide.

## Follow-ups (dashboard-side, out of scope here)

- `ShardSchema` has no `.max()`; an out-of-range coordinate from a non-hardened
  client still 500s instead of 400ing. Add `.max(2_147_483_647)`.
- `expectedShards` is first-writer-wins at open (`coalesce`); disagreeing
  totals are only rejected at `/complete` (`invalidShard`). Consider
  validating agreement at reopen.

## Known limits (inherent to merged runs, documented in README)

- A partial GitHub rerun ("Re-run failed jobs") opens a fresh run that can
  never finalize; the watchdog sweeps it. Use "Re-run all jobs".
- Setup projects pulled in via `dependencies` run once per leg and inflate
  the merged `expectedTotalTests`.

## Verification

- `pnpm --filter @wrightful/reporter test` — 360/360 (contract suite included)
- `pnpm --filter @wrightful/dashboard test` — 777 + 1419, `pnpm check` — 0 errors
