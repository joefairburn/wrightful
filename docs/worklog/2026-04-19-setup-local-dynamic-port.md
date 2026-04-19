# 2026-04-19 — `setup:local` falls back to a free port when 5173 is busy

## What changed

`pnpm setup:local` no longer fails when port 5173 is held by another process
(typically a sibling Conductor workspace's dev server). If the seeded URL
(`http://localhost:5173`) is unreachable and 5173 is busy, setup now picks a
free port, spawns vite with `--port <port>`, uploads fixtures against that
URL, and tears the dev server down on exit. Long-term `pnpm dev` behavior
(`strictPort: true` pinned to 5173 so Better Auth's `WRIGHTFUL_PUBLIC_URL`
stays honest) is unchanged.

Fixture upload hits `/api/ingest` with a Bearer API key, not Better Auth
sessions, so the temporary URL mismatch during the setup window is safe.

## Files touched

- `packages/dashboard/scripts/setup-local.mjs` — added `pickPort(preferred)`
  helper that tries to bind the preferred port on **both** IPv4 (`127.0.0.1`)
  and IPv6 (`::1`) loopback before considering it free. The dual-family check
  matters on macOS, where vite's `localhost` resolves to `::1` first: an IPv4-
  only probe would wrongly accept a port that another vite is already holding
  on IPv6. Falls back to an OS-assigned free port on `EADDRINUSE`, and
  tolerates `EADDRNOTAVAIL` on hosts without IPv6. Replaced the hardcoded
  `seedConfig.url` probes with a `baseUrl` variable that reflects the chosen
  port. Switched the dev-server spawn to
  `pnpm --filter @wrightful/dashboard exec vite dev --port <port>` so `--port`
  forwards cleanly through pnpm's workspace-aware binary resolution; captures
  vite's stdout/stderr so unexpected exits surface a real error message.
  Propagates `WRIGHTFUL_URL=<baseUrl>` to `upload-fixtures.mjs`.
- `packages/dashboard/scripts/upload-fixtures.mjs` — reads
  `process.env.WRIGHTFUL_URL` as an override for `seed.url`. Used for the
  probe and for the CLI upload env. Standalone invocation via
  `pnpm fixtures:generate` still falls back to `seed.url` unchanged. Final
  success message notes when fixtures went to a fallback port.

## Non-goals

- Did not touch `strictPort` or `WRIGHTFUL_PUBLIC_URL` — `pnpm dev` still
  pins 5173 deliberately.
- Did not retrofit dynamic-port spawning into `upload-fixtures.mjs`'s own
  self-spawn fallback (which only runs when that script is invoked
  standalone). Out of scope for this change.

## Verification

- `pnpm lint` — 0 errors (2 pre-existing warnings in
  `src/lib/active-project.ts` and `src/lib/route-params.ts`, unrelated).
- `pnpm typecheck` — passes.
- `pnpm test` — 141 tests passing across cli + dashboard.
- Manual: held 5173 with a Node `net.createServer()` on 127.0.0.1:5173, ran
  `pnpm setup:local`. Output showed `› port 5173 busy… using 60173 for
fixture upload` followed by `› starting dev server… ready`, and the
  fixture scenarios uploaded against the fallback port.
- `pickPort` helper tested in isolation: returns fallback port when 5173 is
  held, returns 5173 when free.
