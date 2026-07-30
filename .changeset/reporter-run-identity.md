---
"@wrightful/reporter": minor
---

**Breaking:** every new execution now needs a distinct idempotency key.

Reporter-generated keys fold in the GitHub run attempt, the selected Playwright
project set, and an optional `WRIGHTFUL_MATRIX_KEY`, so a workflow rerun and
independently-sharded browser-project jobs no longer collide with the execution
they are retrying. Native shards of one job still converge on a single run.

The dashboard now answers a reopened terminal key with `409` instead of
rearming the completed run, so anything that deliberately reused one explicit
`WRIGHTFUL_IDEMPOTENCY_KEY` across separate executions must generate a fresh
value per execution. Reruns of a complete GitHub native-shard set must supply
one fresh key shared by every shard; on GitLab, retry the full pipeline rather
than an individual sharded job.

Upgrade the reporter before the dashboard reaches this behaviour: a `0.2.x`
reporter derives its key from `GITHUB_RUN_ID`, which is stable across reruns,
so a rerun on the old reporter presents the completed run's key and is refused.

Also fixes UTF-8 truncation to preserve mixed chunk order while decoding only
bounded prefixes, and stops duration formatting rendering `60.0s`.
