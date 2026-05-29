# 2026-05-29 — Database performance audit (D1/SQLite, Postgres-forward)

> **Scope:** audit of the data layer — schema, indexes, query plans, caching. The audit
> itself (§1–§7) was read-only; the recommendations were then implemented in follow-up
> commits — see the **Implementation log (§8)**: the query rewrites (§7 items 1–3), the index
> migration (§7 items 5–8, a _new_ numbered migration `20260529222530_stale_ravenous` — the two
> existing migrations `20260523124136_dizzy_wong` / `20260529191148_true_blue_shield` are
> frozen and untouched), and analytics caching (§4). Still outstanding: retention crons + the
> rollup table (§7 items 9–10) and the Postgres index strategy (§7 item 11). Tenant isolation
> is never weakened: every query still filters by `projectId` (and `teamId` where present).

## Method (how the evidence was produced)

Local D1 was empty, so plans would have been meaningless against it. Instead:

1. Built a **scratch SQLite database from the frozen migration SQL verbatim**
   (`db/migrations/*.sql` piped into `sqlite3`), so the schema/index shape is identical to
   production.
2. Seeded **realistic volume**: 2 teams, 3 projects; the primary project (`projA`) has
   **1 800 runs over ~120 days × 200 stable testIds = 360 000 testResults**, plus 387 710
   `testResultAttempts`, 124 200 `testTags`, 7 420 `artifacts`; status mix skewed realistically
   (96.3 % passed, 5 flaky testIds). A second same-team project adds cross-project rows so
   skip-scans are exercised honestly.
3. Ran `ANALYZE` so the planner has `sqlite_stat1` cardinalities.
4. Captured `EXPLAIN QUERY PLAN` for **every** hot query, then validated each proposed fix on
   a _copy_ (drop/add indexes, rewrite query, re-EXPLAIN) to show the **expected post-fix plan**
   and confirm **no regression** on the queries that currently depend on a touched index.
5. Every finding below was **independently re-verified** by a separate reviewer re-running the
   plans (an adversarial pass); corrections from that pass are folded in and called out.

Scratch DBs: `/tmp/wf_audit/audit.sqlite` (frozen schema) and `/tmp/wf_audit/cand.sqlite`
(candidate index set). Reproducible from `seed.sql` + `explain.sql` in `/tmp/wf_audit/`.

---

## 1. Executive summary — highest-impact findings (ranked)

| #     | Finding                                                                                                                                                                                                                                                                                                                                                                             | Impact                                                                                                                                                                          | Effort                            | Type      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------- |
| **1** | **Three indexes are redundant/unused on the hottest write path** — `testResults_runId_idx`, `testResults_status_createdAt_idx`, `testResultAttempts_testResultId_idx`. Every ingest insert maintains them for **zero** read benefit.                                                                                                                                                | Cuts B-tree maintenance per `/results` batch (testResults 6→5 indexes, attempts 2→1); no read regression.                                                                       | Low — 1 migration                 | Write-amp |
| **2** | **`tests`, `slowest-tests` and the `flaky` aggregate filter on `runs.createdAt` through an _unconditional_ `INNER JOIN runs`** — when there's no branch filter the join is a no-op, and filtering the joined table prevents the time window from pruning `testResults` at the index level. The tests-list query is a **full cross-project index scan + a `runs` PK probe per row**. | Filtering `tr.createdAt` and gating the join on `branchFilter` drops the join and prunes via index: **360 k → 42 k rows scanned (−88 %)**, **750 ms → 194 ms** on the seed set. | Low — code only, **no migration** | Hot query |
| **3** | **No retention/purge job exists.** Only one cron is defined (`crons/sweep-stuck-runs.ts`, the watchdog). `testResults` therefore grows **unbounded**, and every analytics window-scan cost grows linearly with retained history forever.                                                                                                                                            | Dominant long-term D1 risk (rows-read billing + latency + storage). The ~90-day run-row / ~30-day artifact policy is documented but **unimplemented in the repo**.              | Medium                            | D1 risk   |
| **4** | **Watchdog cron scans ≈ all runs every 5 minutes.** `WHERE status='running' AND createdAt<cutoff` has no `status` index, so it's a cross-project skip-scan that fetches every run to test `status` per row.                                                                                                                                                                         | A **partial index** `runs(createdAt) WHERE status='running'` makes it a tiny seek over only in-flight runs; costs ~nothing to maintain. Ports straight to Postgres.             | Low — 1 migration                 | Index add |
| **5** | **Optional covering index for the tests page.** With the rewrite in #2, adding `(projectId, testId, createdAt)` turns the tests-list query into a **project-scoped COVERING scan** with the `GROUP BY testId` satisfied by index order (no group sort). Net testResults index count still **drops** (after #1's two removals).                                                      | Removes the cross-project skip-scan entirely; covering = no row fetch.                                                                                                          | Medium — same migration as #1/#4  | Index add |

Smaller confirmed items: stale comment naming a non-existent index in `branches-query.ts:11`;
multi-pass analytics loaders are extra round-trips (latency, not scan cost); the bucket-by-expression
`GROUP BY` necessarily sorts (cheap on `runs`, fine).

---

## 2. Index audit — every index, with verdict

Write cost matters asymmetrically: **`testResults` / `testResultAttempts` / `testTags` are
written on the ingest hot path** (hundreds of thousands of inserts, plus delete-and-replace on
retries), so every superfluous index there is paid repeatedly. `runs` is written ~once per run,
so its indexes are cheap and judged purely on read value.

### `runs` (low write cost)

| Index                                     | Columns                              | Backing reads                                                                                          | Verdict                                           |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `runs_project_idempotency_key_idx` (uniq) | projectId, idempotencyKey            | `openRun` idempotency check (O3)                                                                       | **KEEP**                                          |
| `runs_project_created_at_idx`             | projectId, createdAt                 | runs list order+count (I1/I2), history (J2), all analytics range filters (F1/G1/H), watchdog skip-scan | **KEEP** (workhorse)                              |
| `runs_project_branch_created_at_idx`      | projectId, branch, createdAt         | branch-filtered list/history (I7/J2), `DISTINCT branch` dropdown (I3/L)                                | **KEEP**                                          |
| `runs_project_environment_created_at_idx` | projectId, environment, createdAt    | env filter, `DISTINCT environment` dropdown (I5)                                                       | **KEEP** (low-cardinality but used; writes cheap) |
| `runs_project_actor_idx`                  | projectId, actor                     | actor filter, `DISTINCT actor` dropdown (I4), chosen for `count(*)` (I1)                               | **KEEP**                                          |
| —                                         | createdAt **WHERE status='running'** | watchdog cron                                                                                          | **ADD (partial)** — see §3.K                      |

### `testResults` (HIGH write cost — the index count here is the lever)

| Index                                 | Columns                      | Backing reads                                                                                                          | Verdict                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testResults_testId_createdAt_idx`    | testId, createdAt            | test-detail history (K5), flaky sparkline/failures (B/B2), flaky aggregate GROUP BY skip-scan (A), tests aggregate (D) | **KEEP** (critical)                                                                                                                                                                                   |
| `testResults_runId_idx`               | runId                        | —                                                                                                                      | **DROP** — strict prefix of the `(runId,testId)` unique index; serves nothing it doesn't (proof §3.A)                                                                                                 |
| `testResults_status_createdAt_idx`    | status, createdAt            | —                                                                                                                      | **DROP** — no query filters `status` as a leading predicate; the 2 status filters are secondary to `(projectId,runId)`; 96.3 % of rows are `passed` so it's near-useless even if reached (proof §3.B) |
| `testResults_runId_testId_idx` (uniq) | runId, testId                | ingest upsert / `onConflictDoNothing` (O1), enforces uniqueness, serves runId-only access                              | **KEEP**                                                                                                                                                                                              |
| `testResults_project_runId_idx`       | projectId, runId             | run-detail test list (J3), `test-preview` & `results.ts` (status secondary)                                            | **KEEP**                                                                                                                                                                                              |
| `testResults_project_createdAt_idx`   | projectId, createdAt         | slowest totals/histogram (E1), suite-size `fileRows`/`testsAdded` (F2/F3) — _added today in `true_blue_shield`_        | **KEEP** (well-used)                                                                                                                                                                                  |
| —                                     | projectId, testId, createdAt | tests-list/aggregate (after §3.D rewrite)                                                                              | **ADD (optional)** — §3.E                                                                                                                                                                             |

### `testResultAttempts` (HIGH write cost)

| Index                                               | Columns               | Backing reads                                                                   | Verdict                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testResultAttempts_testResultId_idx`               | testResultId          | —                                                                               | **DROP** — strict prefix of the unique `(testResultId,attempt)`; the planner already uses the unique index for the test-detail read **and** the ingest delete even when this one is present (proof §3.A) |
| `testResultAttempts_testResultId_attempt_uq` (uniq) | testResultId, attempt | test-detail attempts ordered (K3), ingest `onConflict` + delete-by-testResultId | **KEEP**                                                                                                                                                                                                 |

### `testTags` (HIGH write cost)

| Index                       | Columns      | Backing reads                                                                                    | Verdict                                                                                                                                                                                                                 |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testTags_tag_idx`          | tag          | —                                                                                                | **DROP candidate** — no `WHERE tag = ?` exists; `suite-size`'s `GROUP BY tag` drives from `testResults` and sorts in a temp b-tree (does not use this index). Keep only if a "filter tests by tag" feature is imminent. |
| `testTags_testResultId_idx` | testResultId | test-detail tags (K2), flaky tag join (`loadTagsByTestId`), suite-size tag join (F4), FK cascade | **KEEP**                                                                                                                                                                                                                |

### `testAnnotations`, `artifacts`

| Index                              | Columns      | Verdict                                                                                                                                  |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `testAnnotations_testResultId_idx` | testResultId | **KEEP** (test-detail, cascade)                                                                                                          |
| `artifacts_testResultId_idx`       | testResultId | **KEEP** (test-detail K4, artifact-actions N, cascade). Minor: `ORDER BY attempt` does a tiny temp-b-tree sort; not worth a wider index. |

### Control tables (low volume)

`teams_slug_idx`, `teams_lastActivityAt_idx`, `projects_team_slug_idx`,
`memberships_user_team_idx`, `memberships_team_idx`, `teamInvites_*`, `apiKeys_project_idx`,
`apiKeys_keyPrefix_idx`, `userGithubAccounts_githubLogin_idx` — all back their auth/tenancy
lookups (API-key auth uses `apiKeys_keyPrefix_idx`; live-socket authz uses the covering
`memberships_user_team_idx`). **KEEP all.** `teams_lastActivityAt_idx` is updated on every
ingest (`bumpTeamActivity`) but it's a single small index on a tiny table — negligible.

**Net effect of the recommended changes:** `testResults` 6 → 5 app indexes (drop 2, add 1),
`testResultAttempts` 2 → 1, `testTags` 2 → 1, `runs` 5 → 6 (add 1 _partial_, ~free). The hot
ingest path maintains **fewer** B-trees than today while reads get faster.

---

## 3. Hot-query findings (plan evidence → cost driver → fix → expected plan → trade-off)

### A. Redundant indexes are strict prefixes of composite indexes — provably safe to drop

**`testResults_runId_idx` (runId):**

```
-- runId-only query, WITH runId_idx present:
`--SEARCH testResults USING INDEX testResults_runId_idx (runId=?)
-- same query, AFTER dropping runId_idx (only (runId,testId) uniq remains):
`--SEARCH testResults USING INDEX testResults_runId_testId_idx (runId=?)
```

**`testResultAttempts_testResultId_idx` (testResultId):** the planner uses the unique index
**whether or not** the narrow one exists, for both the read and the ingest delete:

```
-- read (test-detail) and DELETE (ingest), with OR without testResultId_idx:
`--SEARCH testResultAttempts USING INDEX testResultAttempts_testResultId_attempt_uq (testResultId=?)
```

**Cost driver:** every `/results` ingest batch inserts rows into these tables (and deletes-then-
re-inserts attempts/tags on retry). Each redundant index is an extra B-tree write per row for no
read.
**Fix:** drop both in a new migration.
**Trade-off / precision (from the verification pass):** dropping `runId_idx` _does_ change the
runId-only plan (it switches to the wider `(runId,testId)` index) — but it remains an **index
seek, not a SCAN**, and no code path does a runId-only query anyway (all add `projectId` or
`testId`). FK `ON DELETE CASCADE` does **not** rely on these userland indexes — SQLite's internal
FK machinery locates child rows independently — and the `(runId,testId)` / `(testResultId,attempt)`
indexes also cover cascade lookups. Functional impact: negligible; write cost: strictly lower.

### B. `testResults_status_createdAt_idx` is unused and low-selectivity

```
-- the only two status filters in the codebase (test-preview.ts, results.ts) — status is
-- SECONDARY to (projectId, runId), so they use project_runId, not status_createdAt:
|--SEARCH testResults USING INDEX testResults_project_runId_idx (projectId=? AND runId=?)
`--USE TEMP B-TREE FOR ORDER BY
-- the index ONLY wins for a status-LEADING query, which does not exist:
`--SEARCH testResults USING INDEX testResults_status_createdAt_idx (status=?)
```

**Cost driver:** maintained on every insert; never the chosen index. Even if reached, `status`
has 5 values and **96.3 % are `passed`**, so it would select almost the whole table.
**Fix:** drop. **Trade-off:** none — verified no consumer.

### C. Flaky aggregate joins `runs` unconditionally (no-op without a branch filter)

`flaky.server.ts:81-94` always `.innerJoin(runs, eq(runs.id, testResults.runId))`, but the join
is only needed when `branchFilter` is set (to filter `runs.branch`). The raw-SQL helpers in the
same file (`loadSparklinesAndMeta`, line 211) already gate the join behind a branch check; the
aggregate does not.

```
-- WITH join (current, no branch filter):       -- WITHOUT join (proposed):
|--SEARCH tr USING INDEX testResults_testId_createdAt_idx (ANY(testId) AND createdAt>?)
`--SEARCH runs USING COVERING INDEX sqlite_autoindex_runs_1 (id=?)   <-- gone when join removed
```

**Cost driver:** one `runs` PK probe **per scanned `testResults` row** (~42 200 probes for a 14-day
window) that cannot change the result — `runId` is a NOT NULL FK so every row matches exactly one
run. `GROUP BY testId` is sort-free in both variants (the `(testId,createdAt)` index provides the
order — note the planner _avoids_ a temp b-tree here).
**Fix:** gate the join on `branchFilter` (mirror the existing raw-SQL helpers).
**Expected plan:** the second block above — bare index search, no `runs` probe.
**Trade-off:** none; identical results.

### D. `tests` / `slowest` filter `runs.createdAt` through the join → full cross-project scan

`tests.server.ts` `runPageQuery` (193-212) and `runAggregateQuery` (222-262), and
`slowest-tests` bottleneck CTE, filter the time window on **`runs.createdAt`** via the join, not
on `testResults.createdAt`. Because the filter is on the _joined_ table, it cannot prune the
`testResults` scan at the index level:

```
-- CURRENT tests-list (runs.createdAt):                 -- REWRITE (tr.createdAt, no join):
|--SCAN tr USING INDEX testResults_testId_createdAt_idx        |--SEARCH tr USING INDEX
|--BLOOM FILTER ON runs (id=?)                                 |     testResults_testId_createdAt_idx
`--SEARCH runs USING INDEX sqlite_autoindex_runs_1 (id=?)      |     (ANY(testId) AND createdAt>?)
`--USE TEMP B-TREE FOR ORDER BY                                `--USE TEMP B-TREE FOR ORDER BY
```

`SCAN` = the **entire `testId` index across all projects** (360 000 entries on the seed set),
plus a `runs` PK probe per row; the window filter happens only _after_ the join. The rewrite turns
it into a `SEARCH` that pushes `createdAt>?` into the index and drops the join.
**Cost driver:** rows scanned. Window holds **42 200 of 360 000** rows → the current plan touches
**8.5× more rows than relevant** (−88 % after the fix). Measured wall-clock on the seed set:
**750 ms → 194 ms** (~3.9×; the real D1 win is rows-read, see §5).
**Fix:** replace `runs."createdAt" >= window` with `tr."createdAt" >= window` and drop the
`INNER JOIN runs` (keep it only when `branchFilter` is set). This applies to **`tests.server.ts`
only** — `slowest-tests` and `flaky` already filter `tr.createdAt`, so for those the fix is purely
dropping the redundant join (no window-column change).
**Semantic change (corrected after review — this is NOT a no-op):** `tr.createdAt` is the result's
**flush/completion time** (stamped in `ingest.ts` when each `/results` batch lands, and re-stamped
on retry), whereas `runs.createdAt` is the run's **open time**; they diverge by the run's duration
in production. (An earlier draft claimed they were "equal for 100 % of rows" — that was an artifact
of the seed generator stamping both columns identically, not a property of the system.) Because
completion ≥ open, the new window (`tr.createdAt >= cutoff`) is a **near-superset** of the old
(`runs.createdAt >= cutoff`): it additionally includes results from a run that opened just before
the cutoff and finished after it — at most one run's duration of boundary fuzz at the far edge of a
7–30-day window. For a retrospective "tests seen in the last N days" catalog this is immaterial and
arguably more correct (it keys on when the test ran, not when the run started). Dropping the join
_requires_ `tr.createdAt` (you can't filter `runs.createdAt` without joining `runs`), so the change
is kept deliberately. The join-removal itself is independently result-preserving: `runId` is a
NOT NULL FK, so every `testResults` row joins to exactly one run.
**Trade-off:** code-only, no migration, no schema risk; a small, bounded boundary-semantics shift on
the tests catalog (accepted).

### E. Optional covering index makes the rewritten tests page project-scoped

On `cand.sqlite` (which has `(projectId, testId, createdAt)`), the rewritten tests-list query
becomes:

```
`--SEARCH tr USING COVERING INDEX testResults_project_testId_createdAt_idx (projectId=?)
```

**COVERING** (no row fetch) and **project-scoped** (no cross-project skip-scan), with `GROUP BY
testId` satisfied by index order — only the final `ORDER BY lastSeen` needs a sort (unavoidable;
`lastSeen` is an aggregate).
**Important nuance (tested, not assumed):** the planner **declines** this index for the _flaky_
aggregate and slowest totals — those need `status`/`durationMs` (not in the index) so they can't be
covering, and the planner prefers the `(testId,createdAt)` skip-scan / `(projectId,createdAt)`
range there. **So the new index is justified by the tests page specifically, not by flaky/slowest.**
This directly answers the column-order question in the brief: `(projectId, testId, createdAt)`
_does_ eliminate the `GROUP BY testId` sort and is covering **for the projection that only needs
`testId`+`createdAt`** (the tests-list page), but is not worth it for status-aggregating queries.
**Trade-off:** +1 index on the hot insert path — but with §2's two `testResults` drops the net
count still falls (6→5). Recommend bundling it with the drops so the write path nets out lighter.

### F. Bucket-by-expression `GROUP BY` sorts; range filter still uses the index (acceptable)

`insights/index`, `suite-size` trend, `run-duration` group by `runs.createdAt / 86400`
(`strftime('%Y-%m', …)` for month). An index cannot order a `GROUP BY` on an expression:

```
|--SEARCH runs USING INDEX runs_project_created_at_idx (projectId=? AND createdAt>?)
`--USE TEMP B-TREE FOR GROUP BY
```

**Cost driver:** the sort — but it's bounded by the _window's run count_ (`runs` is small:
≈1 800 rows for the whole project here, far fewer per window), so the temp b-tree is cheap. The
range filter correctly uses `runs_project_created_at_idx`. **No change recommended for D1.** (See
§6 for the Postgres expression-index option.) Confirmed the `86400`/`604800` divisors are inlined
as **literals**, not bound params — correctly side-stepping D1's text-affinity-on-numeric-params
gotcha noted in `bucketing-sql.ts`.

### G. Run-list dropdowns are index skip-scans; one stale comment

```
DISTINCT branch:      SEARCH runs USING INDEX runs_project_branch_created_at_idx (projectId=? AND branch>?)
DISTINCT actor:       SEARCH runs USING INDEX runs_project_actor_idx (projectId=? AND actor>?)
DISTINCT environment: SEARCH runs USING INDEX runs_project_environment_created_at_idx (projectId=? AND environment>?)
```

All three are covered skip-scans — good. **Doc bug:** `branches-query.ts:11` claims the query is
served by `runs_project_branch_idx`, **which does not exist** in the Void schema (it was an
rwsdk-era index; grep returns zero hits). It's actually served by
`runs_project_branch_created_at_idx`. Harmless but misleading — fix the comment.

### H. Detail / live / ingest paths — well-indexed (minor bounded sorts only)

```
test-detail history:  |--SEARCH tr USING INDEX testResults_testId_createdAt_idx (testId=?)   `--SEARCH runs (id=?)   [no sort]
live authz:           |--SEARCH memberships USING COVERING INDEX memberships_user_team_idx (userId=?)  `--SEARCH runs (id=?)
artifact-actions IN:  |--SEARCH artifacts USING INDEX artifacts_testResultId_idx (testResultId=?)  `--USE TEMP B-TREE FOR ORDER BY
ingest resolve:       `--SEARCH testResults USING INDEX testResults_runId_testId_idx (runId=? AND testId=?)
run-detail test list: |--SEARCH testResults USING INDEX testResults_project_runId_idx (projectId=? AND runId=?)  `--USE TEMP B-TREE FOR ORDER BY
```

No N+1 (children batched via `inArray`/`IN`), no missing indexes, no table scans. **Precision
(verification pass):** the run-detail test list and artifact-actions do incur a `TEMP B-TREE FOR
ORDER BY`, but each is bounded — ≤ `TESTS_LIMIT` (200) rows for one run, ≤ a handful of artifacts
per result — so it's a trivial in-memory sort, not a concern. The flaky/tests `row_number()` CTEs
also use small `LAST TERM OF ORDER BY` temp b-trees over the (≤50) `testId IN` slice — fine.

### K. Watchdog cron scans essentially all runs every 5 minutes

`crons/sweep-stuck-runs.ts`: `WHERE status='running' AND createdAt < cutoff`. No `status` index:

```
-- current: cross-project skip-scan, fetches each run to test status='running'
`--SEARCH runs USING INDEX runs_project_created_at_idx (ANY(projectId) AND createdAt<?)
-- with a PARTIAL index  CREATE INDEX runs_running_idx ON runs(createdAt) WHERE status='running'
`--SEARCH runs USING INDEX runs_running_idx (createdAt<?)
```

**Cost driver:** `cutoff` is "now − 30 min", so `createdAt < cutoff` matches almost every run ever
— the skip-scan visits nearly the whole table across all projects each tick, fetching rows to
filter `status` (which is _not_ in the index). **Fix:** a SQLite **partial index** on
`runs(createdAt) WHERE status='running'`. It contains only in-flight runs (typically a handful),
so the cron becomes a tiny range seek, and it costs ~nothing to maintain (a row enters when a run
opens and leaves when it goes terminal — 2 mutations per run lifecycle). Drizzle supports partial
indexes via `.where()` on the index builder. **Bonus:** ports verbatim to Postgres (partial
indexes are a PG strength).

---

## 4. Caching recommendations

**Current state:** only `runs/:id/summary` (private, 30 s), `:id/tests/:trId/summary` (30 s),
`:id/test-preview` (15 s), and artifact `download` (public, immutable) set `Cache-Control`.
`void.json` has no ISR/edge rules beyond static-asset immutability + security headers. Better Auth
uses KV secondary storage + cookie cache. There is **no app-level KV/edge query cache**.

**Central tension:** `void/live` pushes run progress (`publishRunUpdate` on every ingest write).
Caching an _in-flight_ run's loader makes the SSR seed disagree with the live stream → flicker /
stale "running" forever. So the rule is: **cache by run terminality, and only cache
staleness-tolerant aggregate pages.**

| Path                                                | Expensive?                     | Staleness OK?             | Mechanism                                                              | TTL                | Invalidation                                                          |
| --------------------------------------------------- | ------------------------------ | ------------------------- | ---------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| Insights / flaky / slowest / suite-size loaders     | Yes (window scans, multi-pass) | Yes (retrospective)       | HTTP `Cache-Control: private, max-age=300, stale-while-revalidate=900` | 5 min + 15 min SWR | Time-based; SWR hides recompute. Optional KV bust on `completeRun`.   |
| Runs list + filter dropdowns                        | Moderate (5 parallel scans)    | Mostly (new runs can lag) | `private, max-age=60, stale-while-revalidate=300`                      | 1 min              | SWR; or KV flag keyed `runlist:<projectId>` touched on `completeRun`. |
| Run-history hovercard (`/summary`, `/test-preview`) | Low                            | Yes                       | already cached (15–30 s) — fine; consider raising completed-run TTL    | —                  | —                                                                     |
| **Run-detail loader — in-flight**                   | Moderate                       | **No**                    | `private, max-age=0, must-revalidate`                                  | 0                  | live stream is source of truth                                        |
| **Run-detail loader / results — completed**         | Moderate                       | Yes (immutable)           | branch on `run.status`: terminal → `private, max-age=3600`             | 1 h                | automatic (run immutable)                                             |
| `branches` list (every analytics/run page)          | Low (skip-scan)                | Yes                       | fold into the page cache above                                         | —                  | —                                                                     |

**Guidance:**

- **Always `private`, never `public`,** for tenant-scoped data — edge-caching private rows under a
  shared key is a cross-tenant leak. Queries already enforce `(teamId, projectId)`, and the session
  cookie isolates per user; `private` keeps Cloudflare from sharing entries across tenants. Avoid
  Void ISR / edge cache for `/t/:team/p/:project/*` for the same reason — the auth/tenancy
  correctness risk outweighs the benefit; prefer per-response `private` + SWR.
- **`stale-while-revalidate` is the key primitive here:** it serves the cached aggregate instantly
  while refreshing in the background, so a 5-minute analytics cache never _blocks_ on the heavy
  recompute and new data appears within the SWR window.
- **Cheaper than caching for analytics: rollups.** `runs` already carries denormalized
  `passed/failed/flaky/skipped`, so `insights/index` (run-status-by-bucket) is already reading a
  rollup — it scans `runs`, not `testResults`. The genuinely expensive ones scan `testResults`
  (flaky, slowest, suite-size). If/when those dominate, a **daily/ hourly rollup table**
  (`testStatsByDay(projectId, day, testId, n, passed, flaky, failed, p95…)` built by a cron) lets
  the analytics pages read tiny pre-aggregated rows instead of scanning the window — this scales
  with _retained buckets_, not _retained results_, and composes with retention (#3). Recommend this
  over a query cache once a busy project's `testResults` window exceeds ~1 M rows.

---

## 5. D1 / SQLite risk register

| Risk                                                  | Exposure (at scale)                                                                                                                                                                                                                                                                               | Severity     | Mitigation                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unbounded `testResults` growth — no retention job** | Only `sweep-stuck-runs` cron exists. At 50 runs/day × 500 tests, 90-day window ≈ **2.25 M `testResults`** (+ ~2.5 M attempts, ~0.7 M tags). Every analytics window-scan grows with it.                                                                                                            | **HIGH**     | Implement the documented ~90-day run-row retention (cascades clean children) + ~30-day artifact/R2 sweep, as crons. This is the single biggest lever on analytics cost.                                                                                                                                                                                                                       |
| **Large analytics scans vs D1 rows-read**             | Tests/slowest currently scan the **whole project `testId` index** (360 k here; millions at retention cap) because of the `runs.createdAt` join (§3.D). Even after the fix, a 90-day window over a busy project reads ~hundreds of thousands of rows. D1 bills rows-read and bounds response size. | **HIGH→MED** | §3.D rewrite (−88 % rows) is the immediate fix; retention (#3) bounds the ceiling; rollups (§4) remove the scan for analytics entirely.                                                                                                                                                                                                                                                       |
| **Multi-pass loader round-trips**                     | `flaky` = 3 serial passes (aggregate → then sparkline+failures+tags in parallel); `tests` = 2 passes; `slowest` = 4 (totals → histogram → bottleneck → sparklines). Each pass is a D1 round-trip (latency, not just CPU).                                                                         | MEDIUM       | Acceptable today; the parallel `Promise.all` sub-passes already cut latency. If it bites, merge the sparkline + metadata CTEs and cache the page (§4).                                                                                                                                                                                                                                        |
| **Ingest statement count / 99-param batches**         | A 1 000-test batch fan-outs to many `db.batch` statements (testResults chunked at 7 rows/stmt = 99/14 cols, attempts at 11, tags at 24, annotations at 19) + per-existing-row UPDATE/DELETE triplets. Atomic but chatty.                                                                          | MEDIUM       | Correct & bounded by design. Dropping 3 indexes (§2) reduces per-row write cost. The 99 ceiling is a hard D1 constraint, handled correctly (`MAX_PARAMS_PER_STATEMENT=99`).                                                                                                                                                                                                                   |
| **All reads hit the D1 writer**                       | No read-replica routing; analytics compete with ingest writes on one primary.                                                                                                                                                                                                                     | LOW-MED      | Evaluate D1 **Sessions API / read replication** for the read-only analytics/list loaders (not the ingest path). Bigger lever post-Postgres (Hyperdrive, §6).                                                                                                                                                                                                                                  |
| **Text-affinity on bound numeric params**             | D1 applies text affinity to numeric bound params, which can corrupt arithmetic/comparison.                                                                                                                                                                                                        | LOW          | `bucketing-sql.ts` correctly **inlines** divisors as literals. Audited other arithmetic SQL (`slowest-tests` `bucketMs`, percentile `round(cnt*q)`): `bucketMs`/`HIST_BINS` are interpolated as literals via the `sql` template, and `cnt`/`rn` are columns, not bound params — no exposure found. Keep the inlining convention; add a code comment anywhere a new numeric enters arithmetic. |
| **Response size on sparkline batches**                | `slowest`/`flaky` sparkline CTEs return up to (page testIds × window days) rows; large windows could approach D1 response limits.                                                                                                                                                                 | LOW-MED      | Windows are short (7-day sparkline) and page-bounded (≤50 testIds); fine today. Watch if sparkline windows widen.                                                                                                                                                                                                                                                                             |

---

## 6. Postgres-migration notes

**Won't port as-is (rewrite needed):**

- `strftime('%Y-%m', createdAt, 'unixepoch')` → `to_char(to_timestamp(createdAt), 'YYYY-MM')`
  (or `date_trunc('month', to_timestamp(createdAt))`).
- Integer division `createdAt / 86400`: Postgres `int / int` truncates like SQLite **only if both
  operands are integer** — keep `createdAt` an integer column (or use `(createdAt / 86400)::int` /
  `floor(createdAt / 86400.0)::int`) to preserve bucket semantics.
- Text-affinity divisor-inlining hack is **unnecessary** in Postgres (strict typing) but harmless —
  can stay or be parameterised once on PG.
- `db.run(sql\`…\`)`raw CTEs: the`row_number()`window CTEs port directly (standard SQL). The
discrete-percentile trick`min(case when rn = round(cnt\*q) …)`works as-is, but PG lets you
replace it with native`percentile_cont(0.95) within group (order by durationMs)`/`percentile_disc(…)`— cleaner and less off-by-one-prone (used in`slowest-tests`p95 and`run-duration` p50/p90/p95).

**Postgres wins to adopt:**

- **Partial indexes** — the watchdog (`WHERE status='running'`, §3.K) ports directly; add failure-
  path partials like `(projectId, createdAt) WHERE status IN ('flaky','failed','timedout')` and
  `… WHERE status <> 'skipped'` to serve the flaky/slowest filters without scanning passed rows
  (96 % of the table). These are exactly the predicates §3 showed SQLite can't index well.
- **Expression indexes** for the time buckets:
  `CREATE INDEX … ON runs (projectId, (floor(createdAt/86400)::int))` removes the
  `USE TEMP B-TREE FOR GROUP BY` from §3.F (cheap on D1 today, but free to eliminate on PG).
- **BRIN indexes** on the append-only, monotonic `createdAt` columns (`runs.createdAt`,
  `testResults.createdAt`, `testResultAttempts.createdAt`) — tiny footprint, fast range scans on
  large time-series tables; a natural fit and a strong complement to retention.
- **Hyperdrive** connection pooling removes per-request connection overhead from the multi-pass
  loaders, and PG **read replicas** cleanly offload the analytics/list reads from the ingest writer.
- **No 99-param ceiling** — PG multi-row `INSERT … VALUES` / `COPY` collapses the chunked ingest
  batches; `chunkByParams` can relax substantially.

**Where the schema is shaped by D1 limits PG would relax:** the denormalised `teamId`/`projectId`
on every child table (for join-free logical scope) stays valuable in PG, but PG additionally lets
you back it with **partial / partitioned-by-projectId** strategies if a single project's history
grows huge. Don't reverse the denormalisation (it's also the live-socket single-hop authz) — just
note the extra options.

---

## 7. Prioritised action list

**Quick wins — code only, no migration (do first):**

1. **§3.D** — `tests.server.ts` + `slowest-tests.server.ts`: filter `tr.createdAt` (not
   `runs.createdAt`) and gate the `INNER JOIN runs` on `branchFilter`. (−88 % rows scanned on the
   tests page.) _Impact: HIGH. Effort: LOW._
2. **§3.C** — `flaky.server.ts` aggregate: gate its `INNER JOIN runs` on `branchFilter` (mirror the
   existing raw-SQL helpers). _Impact: MED. Effort: LOW._
3. **§3.G** — fix the stale `runs_project_branch_idx` comment in `branches-query.ts:11`.
   _Impact: docs. Effort: trivial._
4. **§4** — add `Cache-Control` to analytics loaders (`private, max-age=300, swr=900`) and
   terminal-run detail/results (`max-age=3600`); keep in-flight run detail uncached.
   _Impact: MED. Effort: LOW._

**One new numbered migration (`void db generate` from a `schema.ts` edit) — bundle together:** 5. **DROP** `testResults_runId_idx`, `testResults_status_createdAt_idx`,
`testResultAttempts_testResultId_idx` (redundant/unused, §2/§3.A/§3.B). _Impact: write-amp.
Effort: LOW._ 6. **ADD partial** `runs(createdAt) WHERE status='running'` for the watchdog (§3.K). _Impact: MED.
Effort: LOW._ 7. **ADD** `testResults(projectId, testId, createdAt)` to make the rewritten tests page a covering
project-scoped scan (§3.E) — only worthwhile _with_ action #1. _Impact: MED. Effort: LOW._ 8. **(verify then) DROP** `testTags_tag_idx` — no consumer found; keep only if a tag-filter feature
is planned (§2). _Impact: write-amp. Effort: LOW._

- _Net after 5–8: `testResults` 6→5, `testResultAttempts` 2→1, `testTags` 2→1, `runs` +1 partial._

**Larger efforts:** 9. **§5 / #3** — implement retention crons (run rows ~90 d, artifacts/R2 ~30 d). _Impact: HIGH
(caps the unbounded growth that drives every other analytics cost). Effort: MEDIUM._ 10. **§4** — analytics rollup table fed by a cron, once a busy project's `testResults` window
exceeds ~1 M rows; analytics then read rollups instead of scanning results. _Impact: HIGH at
scale. Effort: MED-HIGH._ 11. **§6** — fold the Postgres index strategy (partial / expression / BRIN, Hyperdrive, read
replicas, `percentile_*`) into the migration plan when it lands.

**Constraints honoured:** no schema changed; all schema changes remain additive new migrations
(existing migrations untouched); every query retains its `projectId` (and `teamId`) scope and the
indexes backing tenant isolation are all in the **KEEP** set.

---

## 8. Implementation log

Implemented so far: **8.1** query rewrites (§7 items 1–3), **8.2** the index migration (§7 items
5–8), **8.3** analytics caching (§4). Outstanding: retention crons + rollup table (§7 items 9–10),
Postgres index strategy (§7 item 11).

### 8.1 Query rewrites (§7 items 1–3) — no schema change, **no change to any query's result set**

| File                                                                  | Change                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/t/[teamSlug]/p/[projectSlug]/tests.server.ts`                  | `runPageQuery` + `runAggregateQuery`: window filter switched from `runs."createdAt"` to `tr."createdAt"`, and the `INNER JOIN runs` is now gated behind a `joinSql` that is empty unless a branch filter is active. New `joinSql` arg threaded through both helpers (3 call sites). |
| `pages/t/[teamSlug]/p/[projectSlug]/insights/slowest-tests.server.ts` | All four `runs` joins (totals / histogram / bottleneck / sparkline) gated behind `joinSql` (already filtered `tr.createdAt`, so only the join needed gating).                                                                                                                       |
| `pages/t/[teamSlug]/p/[projectSlug]/flaky.server.ts`                  | Aggregate query rebuilt via `db.select(...).$dynamic()`; the `.innerJoin(runs, …)` is applied only when `branchFilter` is set. The raw-SQL sparkline/recent-failure helpers in this file already gated their joins.                                                                 |
| `src/lib/branches-query.ts`                                           | Fixed the stale doc comment: `runs_project_branch_idx` (rwsdk-era, does not exist) → `runs_project_branch_created_at_idx` (the index actually used).                                                                                                                                |

**Why this is safe:** Two distinct changes, with different safety arguments — separated here after
review flagged that an earlier "the columns are equal" claim was false (a seed artifact):

- **Join removal (all three files):** result-preserving. `runId` is a NOT NULL FK, so every
  `testResults` row joins to exactly one run; the join only ever affected results via the
  `runs.branch` filter, which is retained (with the join) on the branch-filtered path.
- **Window-column swap `runs.createdAt` → `tr.createdAt` (`tests.server.ts` ONLY):** NOT a no-op.
  `tr.createdAt` is flush/completion time, `runs.createdAt` is run-open time; they differ by run
  duration in production. The resulting window is a near-superset of the old (boundary-only
  difference of ≤ one run's duration), accepted as immaterial / more-correct for this retrospective
  catalog. See §3.D for the full reasoning. `slowest-tests` and `flaky` already filtered
  `tr.createdAt`, so they have **no** window-semantics change — only the redundant join was removed.

Expected post-change plans (full cross-project `SCAN` + per-row `runs` probe → bounded
`SEARCH … (createdAt>?)`, join eliminated) are in §3.C/§3.D.

**Verification:**

| Check                                              | Result                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @wrightful/dashboard run typecheck` | Clean (`$dynamic()` conditional join compiles).                                                                                                                |
| `pnpm check:fix` (oxfmt + oxlint)                  | 0 errors; 83 warnings, all pre-existing in untouched files.                                                                                                    |
| `pnpm --filter @wrightful/dashboard test`          | 113/113 pass (10 files).                                                                                                                                       |
| Manual UI / dev-server                             | Not run (per project convention, the user runs `pnpm dev`). Worth a quick smoke of the tests, slowest-tests, and flaky pages with and without a branch filter. |

### 8.2 Index migration (§7 items 5–8) — `db/migrations/20260529222530_stale_ravenous.sql`

Generated with `void db generate` from `db/schema.ts` edits (existing migrations untouched). The
`runs_running_idx` predicate needs `sql`, imported from `void/db` — safe because that module's
`db` export is a lazy `Proxy` (the D1 binding is only resolved on property access, never at import),
so it's side-effect-free at schema-parse time. Generated SQL:

```sql
DROP INDEX `testResultAttempts_testResultId_idx`;
DROP INDEX `testResults_runId_idx`;
DROP INDEX `testResults_status_createdAt_idx`;
CREATE INDEX `testResults_project_testId_createdAt_idx` ON `testResults` (`projectId`,`testId`,`createdAt`);
DROP INDEX `testTags_tag_idx`;
CREATE INDEX `runs_running_idx` ON `runs` (`createdAt`) WHERE "runs"."status" = 'running';
```

Net index counts: `testResults` 6→5, `testResultAttempts` 2→1, `testTags` 2→1, `runs` 5→6 (the
new one partial/near-free). **Validated** by applying all three migrations to a fresh seeded
SQLite DB: every statement executes (SQLite accepts the table-qualified partial predicate), and
the watchdog query then plans as `SEARCH runs USING INDEX runs_running_idx (createdAt<?)` (was a
cross-project skip-scan). `testTags_tag_idx` is dropped on the basis that nothing filters
`WHERE tag = ?`; re-add `(projectId, tag)` if a tag-filter feature lands.

⚠️ **Deploy note:** migrations apply on `void deploy`. `CREATE INDEX testResults_project_testId_createdAt_idx`
on the live `testResults` is a one-time build proportional to row count — the only potentially slow
step; the `DROP INDEX`es and the tiny partial index are instant.

### 8.3 Analytics caching (§4)

Added `Cache-Control: private, max-age=300, stale-while-revalidate=900` to the five retrospective
analytics loaders: `insights/index`, `insights/slowest-tests`, `insights/suite-size`,
`insights/run-duration`, and `flaky`. Set via `c.header(...)` in the loader — the same mechanism
the API summary/test-preview routes use; Void's `serveWithAssets` wrapper only rewrites
`Cache-Control` on 404/asset responses, so a 200 page response keeps the loader's header. `private`
keeps tenant-scoped data out of shared/edge caches; SWR serves instantly while revalidating.
**Deliberately not cached:** the in-flight run-detail loader (driven by `void/live` — must stay
fresh) and the tests-catalog list (interactive search/paginate; easy to add later if wanted).

⚠️ **Verify at runtime:** I confirmed page-loader headers propagate by source inspection but could
not exercise it without the dev server (project convention: the user runs `pnpm dev`). Worth a
quick `curl -I` / DevTools check on `…/insights/run-duration` to confirm the `Cache-Control` header
is present on the response. If it isn't, the fallback is a small response-header middleware keyed on
the analytics pathnames — the headers are otherwise a no-op (nothing cached), never a stale-data bug.

### Verification (8.2 + 8.3)

| Check                                              | Result                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `void db generate`                                 | Produced `20260529222530_stale_ravenous.sql`; frozen migrations untouched; journal appended. |
| Apply all 3 migrations to fresh SQLite             | Clean; final index set as intended; watchdog uses `runs_running_idx`.                        |
| `pnpm --filter @wrightful/dashboard run typecheck` | Clean (`schema.ts` `void/db` import + partial index; `c.header` in loaders).                 |
| `pnpm check:fix`                                   | 0 errors; 83 pre-existing warnings (untouched files).                                        |
| `pnpm --filter @wrightful/dashboard test`          | 113/113 pass.                                                                                |
