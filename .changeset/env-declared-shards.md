---
"@wrightful/reporter": minor
---

Let a CI matrix that shards the suite without `--shard` declare its shard
coordinates via `WRIGHTFUL_SHARD_INDEX` (1-based) and `WRIGHTFUL_SHARD_TOTAL`,
so legs sharing one `WRIGHTFUL_IDEMPOTENCY_KEY` merge into a dashboard run that
waits for every leg instead of finalizing on the first `/complete`. Playwright's
`--shard` takes precedence; a partial or malformed declaration warns and falls
back to the single-run shape. Both variables are inert on older reporters.

Two new misconfiguration warnings: an explicit `WRIGHTFUL_IDEMPOTENCY_KEY` with
no shard coordinates on a detected CI provider (if legs share that key, the run
finalizes early and late legs are rejected), and env-declared coordinates
without a shared explicit key (legs derive different keys and each opens a run
that can never finalize). Synthetic-monitor executions
(`WRIGHTFUL_RUN_ORIGIN=synthetic`) are explicitly excluded from the first
warning.

Ported from gitasf/bumper-playwright-dashboard#23 with hardening.
