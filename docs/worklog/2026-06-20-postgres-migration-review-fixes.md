# 2026-06-20 — Postgres-migration review fixes (coercion bugs, CI gaps, doc rot)

## What changed

A thermo-nuclear code-quality review of the `dual-dialect-schema-support` branch (the
D1→Postgres-only migration + own-account Cloudflare deploy + workerd test lane) surfaced
25 findings (18 confirmed, 7 partial, 0 refuted) after adversarial verification. This
entry records the fixes applied for all of them. The migration's architecture was sound;
the issues were concentrated in (a) the int8-as-string numeric-coercion trap leaking into
analytics loaders, (b) CI/test-lane wiring, and (c) documentation left describing the
abandoned dual-dialect / D1 architecture.

### 1. Numeric-coercion correctness (the headline)

On the production node-postgres driver, `count(*)`, `sum(int)` (int8) and `avg`/`numeric`
come back as JS **strings**; the pglite test lane returns numbers and hides it. The
migration converted the files it touched (`usage.ts`, `monitors-repo.ts`, `per-test.ts`)
but missed the page-level analytics loaders. Fixed by applying the canonical two-path
coercion:

- **Builder path** (`db.select({...})`) — wrapped aggregates in `numericSql(...)`
  (`@/lib/db/sql-ops`, attaches `.mapWith(Number)`):
  - `flaky.server.ts` — `total`/`flakyCount`/`passedCount` (**blocker**: `flakyCount +
passedCount` was string-concatenating → wrong flaky % and ranking).
  - `insights/index.server.ts` — `passed`/`failed`/`flaky`/`skipped`/`runs` (**high**:
    corrupted stacked-bar chart + KPI totals via `+=`).
  - `insights/suite-size.server.ts` — both `count(distinct …)` distribution selects.
  - `t/[teamSlug]/p/[projectSlug]/index.server.ts` and
    `settings/teams/[teamSlug]/audit.server.ts` — pagination `count(*)`.
- **Raw-read path** (`runRows`/`runRow` via `db.execute().rows`) — added `cast(… as
integer)` (counts) / `cast(… as double precision)` (avgs) inside the SQL:
  - `tests.server.ts` — `totalDistinct`, `n`, `avgDurationMs`.
  - `insights/slowest-tests.server.ts` — `n`, `unique`, `max(cnt)`, two `avg`s.
  - `insights/run-duration.server.ts` — both `max(cnt) as cnt`.
  - `suite-size.server.ts` — `count(*) as added`.
  - (`max`/`min` over `integer` columns return int4→number and were left alone.)
- **Trap-proofing** — new node-lane regression test
  `src/__tests__/aggregate-coercion-guard.test.ts` scans `pages/**/*.server.ts` +
  `src/**/*.ts` and fails on any bare `sql<number>` / `sql<number | null>` wrapping
  `count(`/`sum(`/`avg(` (the intentional `sql<number | string>` bucket-key union and
  `sql-ops.ts` are exempt). This closes the systemic gap — the original review's sweep had
  itself missed these because it only scanned `src/`, not `pages/`.

### 2. CI / test-lane wiring

- **`.github/workflows/ci.yml`** — the `test-dashboard` job only ran `test:coverage` (Node
  lane, 131 tests); the 96-file / 1036-test **workerd lane** built specifically for this
  migration's runtime-fidelity risk never gated CI. Added a step running
  `pnpm --filter @wrightful/dashboard test:workers` (inline miniflare — no `wrangler.jsonc`
  dependency, so CI-safe with no extra infra).
- **`rate-limit-config.test.ts`** — read the now-gitignored generated `wrangler.jsonc`
  (ENOENT on a clean CI runner). Repointed at the committed `wrangler.template.jsonc`,
  whose `ratelimits[]` block is byte-identical and untouched by `gen-wrangler`, removing the
  dependency on a generated artifact.
- **`vitest.shared.ts`** (new) — extracted the duplicated test path constants + `void/db`
  alias map (and `MINIFLARE_BASE`) shared by `vite.config.ts`, `vitest.workers.config.ts`,
  and `vitest.workers.db.config.ts`, so the Node and workerd lanes provably resolve
  `void/db` to the same stub. (The larger `test.projects` unification stays deferred.)

### 3. Deploy-tooling hardening

- **`gen-wrangler.mjs`** — `fromEnv` now strips trailing inline comments from **unquoted**
  `.env` values (the shipped `.env.example`/`SELF-HOSTING.md` hints would otherwise produce
  a malformed `bucket_name`/worker name on the own-account path); and a missing
  `__CF_OWN_ACCOUNT_BINDINGS__` marker now throws instead of silently dropping the
  hyperdrive/R2 bindings while printing success.
- **`.env.example` / `SELF-HOSTING.md`** — moved each `CF_*` hint to its own comment line
  above the var so a verbatim copy into `.env.local` is parser-safe.
- **`package.json`** — removed the duplicate `wrangler:gen` script (byte-identical to the
  `cf:prepare` all the pre-hooks already call).

### 4. Maintainability / code-judo

- **`ingest.ts` `resolveTestResultIds`** — deleted the now-dead IN-list chunking fan-out
  (the cap moved to 65533 but a `/results` batch is ≤5000, so it was always one chunk),
  collapsing it to a single `db.select(...).where(inArray(...))` and removing the false
  "~52 chunks / ~1s latency" D1 rationale.
- **`db-batch.ts`** — narrowed `BatchExecutor` from `typeof db | Tx` to `Tx` and made the
  six statement-builder helpers' `exec` required (no standalone caller existed); dropped the
  misleading "for standalone use" doc.
- **`ingest.ts` `openRun`** — replaced the throwaway `((u) => (u ? [u] : []))(…)` IIFE with
  a block-body builder matching `appendRunResults`.
- **`ingest.ts` `appendRunResults`** — documented the `mapping` side-channel's ordering
  invariant (runBatch invokes the builder synchronously).

### 5. Documentation rot — the dual-dialect ghost

The Postgres-only pivot deleted the dual-dialect codegen layer but left comments naming it.
Swept:

- **`schema.ts`** — removed the false `GENERATED FILE — DO NOT EDIT` header pointing at four
  nonexistent files (`schema.d1.ts`, `gen-pg-schema.mjs`, `dialect-columns.mjs`,
  `schema-parity.test.ts`); it now correctly states the file is the hand-authored pg-core
  source of truth, migrations via `pnpm db:generate` (= `void db generate`). Also swept
  ~12 body comments from D1/SQLite engine prose to Postgres (incl. re-attributing the
  `COALESCE(role,'')` NULL-distinctness rationale to Postgres, where the invariant still
  holds; and "one SQLite file per team" → the single-shared-store logical-tenancy model).
- **`ingest.ts`** — updated `db.batch`/"D1 batch"/"D1 transaction" docstrings to the
  Postgres `db.transaction` reality (incl. the now-false "the db.batch call-signature cast
  lives once in runBatch"); fixed the 99/100-param D1 cap references; dropped "D1
  meta.changes" from the `changedRows` docstring.
- **`decline.ts`** — dropped the "both backends (D1 meta.changes, …)" `changedRows` comment.
- **`gen-wrangler.mjs` / `wrangler.template.jsonc`** — reworded the dangling
  `apply-dialect.mjs` references (that script was deleted in the Postgres-only pivot).
- **`vite.config.ts`** — "bootstrap D1 migrations" → "bootstrap the database".

## `@cloudflare/vite-plugin` patch — rationale (closing the undocumented-patch finding)

`patches/@cloudflare__vite-plugin@1.38.0.patch` (declared in `package.json`
`pnpm.patchedDependencies`) was undocumented in-repo. Recording it here:

- **Symptom:** Void's plugin auto-injects a `nodejs_compat` compatibility flag, while
  `wrangler.template.jsonc` / `void.json` also declare it — producing a _duplicate_
  `compatibility_flags` entry that the Cloudflare build rejects.
- **Fix:** in `customizeWorkerConfig` (the `defu(configResult, options.workerConfig)` merge
  in the minified `dist/index.mjs`), the patch dedups `compatibility_flags` via
  `[...new Set(...)]`.
- **Provenance / fragility:** `@cloudflare/vite-plugin` is transitive via the Void toolchain
  (no direct workspace dependency). The patch edits a minified dist line, so a Void bump can
  shift the offset/context; pnpm then **refuses to apply** the patch (a loud install
  failure, not silent corruption — the safe mode).
- **Re-derivation when a Void bump breaks it:** find `customizeWorkerConfig` /
  `defu(configResult, options.workerConfig)` in the new `dist/index.mjs`, wrap the merged
  `compatibility_flags` array in `new Set`, and regenerate the patch.

## Verification

- `pnpm check` (format + lint + type-check): **0 errors** (108 pre-existing warnings in
  untouched code, e.g. `packages/reporter/src/client.ts`).
- `pnpm --filter @wrightful/dashboard test`: **Node lane 131/131 passed**, **workerd lane
  1036/1036 passed**.
- New `aggregate-coercion-guard.test.ts` passes and now guards the whole `pages/` + `src/`
  surface against future bare-`sql<number>` aggregate regressions.
- `node scripts/gen-wrangler.mjs` smoke-tested: generic fallback with no `CF_*`; unquoted
  values with trailing ` # …` now produce clean bindings; quoted `#` preserved.
- The own-account real-DB lane (`test:workers:db`) still requires a live Postgres and is
  intentionally left out of CI (it self-skips without `DATABASE_URL`); the main workerd lane
  is the priority gate added here.
