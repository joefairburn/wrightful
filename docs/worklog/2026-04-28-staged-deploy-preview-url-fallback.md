# 2026-04-28 — Staged deploy: preview URL fallback for worker-name overrides

## What changed

`staged-deploy.mjs` now constructs the per-version preview URL itself when wrangler omits it from the `version-upload` event. Previously the script bailed with "Upload event missing version_id or preview_url" whenever Cloudflare Workers Builds overrode the worker name (`worker_name_overridden: true`), which it does on every deploy when the dashboard's Worker name doesn't match `wrangler.jsonc`'s `"name": "wrightful"`.

Wrangler 4.83 has a bug (or undocumented behavior) on the override path: the upload to Cloudflare succeeds and the version is created, but the `version-upload` ND-JSON event ships with `preview_url` undefined even when `workers_dev` and `preview_urls` are both enabled on the Worker. So the script's hard requirement on `preview_url` made the staged deploy unusable for any self-hoster whose CF Worker is named anything other than `wrightful`.

## Details

| Change                                                                | File(s)                                        |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| Construct preview URL from `worker_name` + first 8 of `version_id`    | `packages/dashboard/scripts/staged-deploy.mjs` |
| New build env var `WORKERS_SUBDOMAIN` documented                      | `SELF-HOSTING.md`                              |
| Assert `workers_dev: true` + `preview_urls: true` (belt + suspenders) | `packages/dashboard/wrangler.jsonc`            |

The fallback uses the same template wrangler does internally (per `cloudflare/workers-sdk`'s `packages/wrangler/src/versions/upload.ts`):

```
https://<first-8-of-version-id>-<worker-name>.<subdomain>.workers.dev
```

`WORKERS_SUBDOMAIN` is the part between the worker name and `.workers.dev` in the user's preview URLs. It's only required when the override path triggers — self-hosters who name their CF Worker `wrightful` won't need it.

## Why a new env var rather than a CF API call

Querying `accounts/:account_id/workers/subdomain` would let us derive the subdomain at deploy time without any extra config. But that requires `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in the build env, neither of which CF Workers Builds auto-injects (cloudflare/workers-sdk#10811). So the API path needs two new env vars vs. one — net regression. Single-string env var wins.

## Why not just rename the worker

Self-hosters following Path A (Cloudflare dashboard → "Connect to Git") create a Worker via the dashboard's name field, which they typically pick before reading the docs. Asking them to recreate the Worker after the fact is a worse onboarding bump than setting one extra env var. Path B (CLI-only) users have always been able to keep `wrangler.jsonc`'s name and never see this.

## Verification

- `staged-deploy.mjs` parses cleanly under oxlint + oxfmt.
- The fallback path can't be exercised locally (it requires CF Builds' override behavior). Remote verification is the next deploy with `WORKERS_SUBDOMAIN` set on the user's `wrightful-bumper` instance.
