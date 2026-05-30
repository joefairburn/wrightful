# 2026-05-30 — Auth-users owner module (void-owned `user`/`account` raw SQL) + github-login mirror seam

## What changed

Concentrated every read against the **void-owned** Better Auth tables (`user`, `account`) and the directed-invite identity-matching logic — previously smeared across six call sites with case/limit drift and re-derived `.toLowerCase()` — behind a single owner module, `src/lib/auth-users.ts`. Split out the **write** side of the `userGithubAccounts` mirror (the GitHub-login capture-and-upsert that `auth.ts` ran as two byte-identical `account.{create,update}.after` closures) into its own `src/lib/github-account-mirror.ts` seam.

These two tables are intentionally NOT declared in `db/schema.ts` (void/auth owns their migration shape), so each cross-table read had to drop to raw SQL and hand-cast the untyped D1 result envelope (`.results?.[0] as { ... }`). Left duplicated, a single site forgetting to lowercase the matched email is an invite-hijack vector — so this is a security-load-bearing consolidation, not just DRY.

This entry covers the `auth-users-module` cluster of the 2026-05-30 architecture deepening review: findings **F56, F72, F54, F37, F58, F55**. F72/F54/F37 turned out to be the same finding as F56 (verified during implementation) and are subsumed by it; F58 is the explicitly-conditional rider that folded `account`-row storage knowledge into the `getUserAccounts` adapter rather than a standalone seam.

## Details

New module `src/lib/auth-users.ts` — the **only** file that issues raw SQL against `"user"` / `account`:

| Export                                          | Purpose                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getUserIdentity(userId)`                       | Resolve `{ email, githubLogin }` for a directed-invite redemption. Raw `"user".email` read in parallel with the `userGithubAccounts` Drizzle lookup; email lowercased here so callers never have to remember to.                                         |
| `getUsersByIds(ids)`                            | Hydrate `{ email, name, image }` for a set of user ids into a `Map`, with each id bound as its own SQL parameter (never interpolated). Replaces the members-page `memberships ⋈ "user"` raw read.                                                        |
| `getUserAccounts(userId)`                       | Read the void-owned `account` rows (one per provider). The single home for the `account`-table name + envelope cast (F58).                                                                                                                               |
| `getUserAuthProfile(userId)`                    | Project the `account` rows + mirror login into `{ hasPassword, github }` for the Settings → Profile loader.                                                                                                                                              |
| `buildInviteMatchConds(identity)`               | The `or(...)` of `teamInvites` equality predicates an identity may redeem against; returns `null` for an undirected identity so callers 403 instead of building an empty `or()`. Replaces the `matchConds` assembly hand-written in three invite routes. |
| `identityMatchesInvite` / `inviteMatchedBy`     | Pure match + channel-classification selectors.                                                                                                                                                                                                           |
| `coerceAccountCreatedAt` / `projectAuthProfile` | Pure helpers owning the number-OR-ISO `account.createdAt` quirk and the `credential`=has-password / `github`=OAuth-link provider-id semantics.                                                                                                           |

New module `src/lib/github-account-mirror.ts` — the write side of the mirror (F55):

| Export                                                    | Purpose                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `captureGithubLogin(userId, accessToken)`                 | Best-effort fetch of the GitHub login + upsert into `userGithubAccounts`. Keeps the dynamic `void/db` / `@schema` imports inside the body so `auth.ts` stays loadable at `void prepare` config time.                                                                                       |
| `runGithubAccountMirror(account, chainDefault, capture?)` | The orchestration both `auth.ts` hooks shared: chain the default `after` first, guard `providerId === "github"`, `logger.warn` (not swallow) on capture failure, never throw into the hook. `capture` is injected so the ordering/guard/log invariants are unit-testable without real I/O. |

## Code fixes / migrations

- `auth.ts` — the two `account.{create,update}.after` closures collapse to one-line `mirrorGithubAccount(account, chainDefault)` delegations into `runGithubAccountMirror`; `MirrorableAccount` is imported type-only. No schema change (mirror table `userGithubAccounts` already exists).
- `src/lib/invite-identity.ts` — `inviteMatchesUser` now delegates to `getUserIdentity` + `identityMatchesInvite` (dropped its own raw `"user"` read).
- `src/lib/authz.ts` (`getPendingInvitesForUser`), `routes/api/invites/[inviteId]/accept.ts`, `.../decline.ts` — all three now resolve identity via `getUserIdentity` + `buildInviteMatchConds`.
- `pages/settings/profile.server.ts` — loader is now a pure projection over `getUserAuthProfile`.
- `pages/settings/teams/[teamSlug]/members.server.ts` — member profiles hydrated via `getUsersByIds` (preserving the original INNER-JOIN drop-missing-row semantics via `flatMap`).
- `src/__tests__/helpers/void-db-stub.ts` — added a `sql.join` shim so the stubbed `void/db` can record the parameter-bound id list used by `getUsersByIds`.

## Tests

- `src/__tests__/auth-users.test.ts` — pins the pure half: `buildInviteMatchConds` (incl. the null-for-undirected 403 guard and the exact column→value predicate it emits), `identityMatchesInvite` (incl. null≠null is NOT a match), `inviteMatchedBy`, `coerceAccountCreatedAt`, `projectAuthProfile`.
- `src/__tests__/github-account-mirror.test.ts` — pins `runGithubAccountMirror`'s ordering (default-before-capture, awaits async default), the non-github skip, arg forwarding, the warn-on-failure-not-swallow signal, never-throw-into-hook, and default-`after` error propagation.

The DB-issuing reads (`getUserIdentity` / `getUsersByIds` / `getUserAccounts`) hit D1 and can't run under the void/db stub — they remain an integration gap, covered structurally by the pure tests on the logic they wrap.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 222 passed (was ~192; +30 from this cluster's two new suites).
- `pnpm --filter @wrightful/reporter test` — 150 passed.
- `pnpm check` — 0 errors, 77 warnings.
