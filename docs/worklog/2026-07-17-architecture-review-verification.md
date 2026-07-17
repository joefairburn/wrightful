# 2026-07-17 — Architecture-review integration verification

## Scope

Coordinated verification for the platform-hardening work collected in commit
`d71eb74`. The individual 2026-07-16 worklogs record focused checks run by each
workstream; this pass exercised the combined repository, production build,
migrations, reporter stream, and canonical dashboard browser suite.

## Documentation corrections

- `SELF-HOSTING.md` now documents that a closed fresh instance requires a
  temporary `WRIGHTFUL_BOOTSTRAP_FIRST_TEAM=true` window before its first team
  can be created. The operator setup steps say when to disable it again.
- `apps/dashboard/.env.example` includes the same bootstrap guidance.
- The trace-viewer fallback is described consistently as safe and usable with
  reduced snapshot fidelity, rather than fully functional.

## Verification

- `pnpm check` — passed: all 1,086 files formatted, zero lint/type errors. The
  checker reported 143 warning-level findings.
- `pnpm test` — passed:
  - dashboard node lane: 649 passed, 4 skipped;
  - dashboard workers lane: 1,369 passed;
  - reporter: 304 passed.
- `pnpm build` — passed for the production dashboard bundle and packaged
  reporter.
- `pnpm test:e2e` — 29 passed against a production preview and PostgreSQL 16,
  including migration reset, Better Auth bootstrap, real reporter streaming,
  MCP queries, artifact paths, and sharded ingest.
- `pnpm --filter @wrightful/e2e test:dashboard` — 51 passed, 1 intentionally
  skipped, including auth, tenant isolation, realtime, monitor scheduling,
  production SSR, and embedded trace replay.

The E2E environment required PostgreSQL 16 with `pg_trgm`, the pinned Playwright
Chromium build, its shared-library dependencies, and fontconfig data. Initial
setup failures were environmental and the suites passed unchanged after those
prerequisites were installed.

## Remaining manual verification

The optional cookieless trace-viewer origin still requires a real two-hostname
Cloudflare deployment to verify DNS/routing, cross-origin framing headers,
service-worker registration, cookie isolation, and the `postMessage` handshake.
That infrastructure is unavailable in the cloud coding sandbox; the safe
same-origin mode is covered by unit and dashboard E2E tests.
