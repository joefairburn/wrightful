# 2026-06-13 — Remove public / shareable run links (revert roadmap 1.4)

## What changed

Removed the public run-share feature added earlier today (roadmap 1.4, commit `d96284c`). **Product decision: everything stays behind auth** — there are no anonymous/public views, so signed public share links don't fit the model.

Reverted cleanly (the feature never deployed — pre-launch):

- **Deleted:** `src/lib/share-tokens.ts`, `src/components/share-run-button.tsx`, `routes/api/t/.../runs/[runId]/share.ts`, the `pages/share/**` public page, and `src/__tests__/share-tokens.test.ts`.
- **Schema:** dropped the `runShares` table + `RunShare` type. Since the feature never shipped, the migration was removed rather than create-then-dropped: deleted the `runShares` migration (`20260613164459`) **and** the 2.1 testTags-index migration (`20260613165815`) — both snapshots were cumulative and contained `runShares` — then regenerated the testTags index cleanly against the post-GitHub snapshot (new `20260613213453_quiet_ultimates.sql`, which is just `CREATE INDEX testTags_project_tag_idx`). Journal trimmed to match. `void db generate` now reports no drift.
- **Stripped references:** `SHARE_TOKEN_SECRET` from `env.ts`, `resolveShareTokenSecret` from `config.ts`, the `<ShareRunButton>` from the run-detail header.
- **Docs:** removed `docs/roadmap/1.4-public-share-links.md` + its worklog; marked 1.4 dropped in `docs/roadmap/README.md`.

Tier 1 now ships three features (usage metering, retention, GitHub checks).

## Verification

- `vp exec void db generate` (×2) — second run reports "No schema changes" (chain consistent, no `runShares` in any snapshot).
- `vp exec tsgo --noEmit` — clean.
- `vp test run` — **900 passed (86 files)** (the 6 share-token tests removed with the feature).
- `vp check` — 0 errors.
- Repo-wide grep for `share-tokens`/`runShares`/`ShareRunButton`/`SHARE_TOKEN_SECRET`/etc. — no code references remain.
