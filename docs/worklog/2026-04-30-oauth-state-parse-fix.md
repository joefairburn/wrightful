# 2026-04-30 — Fix GitHub OAuth `state` parsing in ControlDO

## What changed

GitHub sign-in on the deployed Worker was failing on the OAuth callback with:

```
ERROR [Better Auth]: Failed to parse state SyntaxError: "[object Object]" is not valid JSON
```

Regression introduced by the D1 → ControlDO move ([2026-04-29-control-do.md](2026-04-29-control-do.md)).

Fixed by disabling rwsdk's default `ParseJSONResultsPlugin` on both `ControlDO` and `TenantDO` — passed an empty `plugins` array through the rwsdk `SqliteDurableObject` constructor.

## Root cause

`rwsdk@1.2.0`'s `SqliteDurableObject` defaults its Kysely instance to:

```ts
plugins = [new ParseJSONResultsPlugin()];
```

That plugin walks each result row and auto-parses any string that _looks_ like JSON (starts with `{`/`[`, ends with `}`/`]`) into a JS object/array. It runs on the DO side, so by the time a row crosses the RPC boundary back to the worker it's already been deserialized.

Better Auth's OAuth state flow (`better-auth@1.6.5/dist/state.mjs`):

1. **Write**: `internalAdapter.createVerificationValue({ value: JSON.stringify({...stateData, oauthState: state}), ... })` — `value` lands as a JSON **string**.
2. **Read**: `parsedData = stateDataSchema.parse(JSON.parse(data.value))`.

With the plugin enabled, step 2 calls `JSON.parse(<object>)`, which coerces the object via `String(obj)` → `"[object Object]"`, then fails to parse. Hence the exact error in the callback log.

D1 didn't go through this path — `D1SqliteDialect` returns raw strings — so Better Auth worked unchanged before the migration.

A related latent bug existed in `packages/dashboard/src/lib/github-orgs.ts`: `parseOrgsJson(row.orgSlugsJson)` calls `JSON.parse` on the same auto-parsed result, but it swallows the `SyntaxError` in a `try/catch` and silently returns `[]`. The GitHub-orgs cache had been silently empty since the ControlDO migration. The same fix resolves it; users get accurate org membership cached again on first GitHub sign-in.

## Code changes

| File                                           | Change                                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/control/control-do.ts` | Add `constructor(ctx, env)` that calls `super(ctx, env, controlMigrations, "__migrations", [])` to disable `ParseJSONResultsPlugin`.                                                                                  |
| `packages/dashboard/src/tenant/tenant-do.ts`   | Same shape — disable `ParseJSONResultsPlugin` for symmetry. No symptom today, but the same foot-gun was live (any tenant string column whose contents happen to start with `{`/`[` would have been silently mutated). |

The class field `migrations = ...` is left in place on both DOs — redundant once passed through `super`, but cheap insurance for code that might read `.migrations` off the instance.

## Why empty-plugins is the right answer

- All app code that handles JSON-shaped columns (`verification.value`, `userGithubOrgs.orgSlugsJson`) does its own `JSON.parse` and expects raw strings.
- Better Auth, the strictest consumer, contractually requires raw strings.
- We don't store JSON columns we want auto-deserialized today. If we ever do, the right thing is per-column opt-in serdes — not a global "parse anything that looks like JSON" plugin.

## Verification

| Check                                                                                                                 | Result           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `pnpm typecheck`                                                                                                      | Clean            |
| `pnpm --filter @wrightful/dashboard test` (vitest unit)                                                               | 157 / 157 passed |
| `pnpm --filter @wrightful/dashboard exec vitest run --project integration` (TenantDO/ControlDO migration + RPC tests) | 8 / 8 passed     |

Production check (manual, after `wrangler deploy`):

- Hit `/sign-in`, click "Continue with GitHub", complete consent.
- Expect a clean redirect to `/` (team picker) and no `Failed to parse state` line in Logpush for the callback request.
- Expect `getCachedUserOrgs(userId)` to return the populated org list (i.e. team-suggestion list isn't blank for users who belong to orgs Wrightful is permitted to see).
