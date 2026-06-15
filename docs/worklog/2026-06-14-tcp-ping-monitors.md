# 2026-06-14 — TCP / ping monitors (roadmap 2.6)

## What changed

Added a third synthetic-monitor type — **TCP / ping checks** — mirroring the
existing, complete HTTP-uptime slice end to end. A TCP monitor opens a raw socket
to a `host:port` on a schedule via `connect()` from `cloudflare:sockets`,
measures the connect latency, and settles `pass` if the connection opens within
the configured timeout, `fail` (DOWN) otherwise. It reuses the entire monitoring
machinery the HTTP slice established: the `monitors` / `monitorExecutions` tables
(NO schema change — the `type` column already reserved `"tcp"|"ping"`), the
scheduler + sweep, the `uptime` queue, the pure `runMonitorJob` orchestrator, the
`recordExecutionResult` settle path, the per-project cap pattern, the detail-page
uptime windows, and the type chooser.

**"Ping" is modelled as a TCP connect, not ICMP.** Cloudflare Workers cannot send
ICMP echo packets — the runtime exposes only `connect()` (TCP) and `fetch()` for
egress. So a `"ping"` monitor is the SAME probe a `"tcp"` monitor uses: open a TCP
connection to `host:port` and measure the handshake. This is documented
prominently in `tcp/tcp-run.ts`. "Reachable" therefore means "the port accepts a
connection within the timeout" — which is what uptime monitoring actually cares
about (a service is up), and strictly more useful than an ICMP echo (a host can
answer ping while its service is down). A raw TCP connect also works for ANY port
(databases, SMTP, Redis, SSH), unlike the HTTP-HEAD alternative the plan floats.
The v1 form only offers `type=tcp`; `"ping"` shares the executor, config, cap, and
routing 1:1 — it is supported throughout the dispatch/sweep but has no separate
form (the executor would just label it).

**SSRF / host-policy reuse.** The genuinely shared part of the HTTP URL policy —
the private/loopback/link-local/metadata block set — was extracted: `isBlockedHost`
in `http/url-policy.ts` was renamed to `isBlockedHostname` and **exported**, and
the new `tcp/host-policy.ts` (`checkTcpHostPolicy`) imports it so the http and tcp
guards block the EXACT same hosts (one place to add a new internal range). TCP
needs its own policy wrapper because it stores a bare host + port (no scheme /
path / credentials to vet), so `checkTcpHostPolicy` adds bare-host shape
validation (rejects a pasted URL / `user@host` / path) around the shared block
kernel. The guard binds at the same two points the http URL does: the config-write
refinement (`TcpMonitorConfigSchema.host`) AND every executor run (the executor
parses the stored config back through that schema, and additionally re-checks the
host immediately before `connect()` as belt-and-braces for a future direct-DB
write / schema relaxation).

## Details

| Concern                 | HTTP (existing)                          | TCP (added)                                                            |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Executor (pure, DI'd)   | `http/http-run.ts` `runHttpCheck`        | `tcp/tcp-run.ts` `runTcpCheck`                                         |
| Executor (thin adapter) | `http/http-executor.ts`                  | `tcp/tcp-executor.ts` (imports `connect`)                              |
| SSRF guard              | `http/url-policy.ts` `checkUrlPolicy`    | `tcp/host-policy.ts` `checkTcpHostPolicy` (reuses `isBlockedHostname`) |
| Config schema           | `HttpMonitorConfigSchema`                | `TcpMonitorConfigSchema` (host/port/connectTimeoutMs)                  |
| Result detail           | `HttpResultDetail` + Zod mirror          | `TcpResultDetail` (host/port/timings) + Zod mirror                     |
| Form-parse              | `httpConfigFromForm`                     | `tcpConfigFromForm`                                                    |
| Form component          | `http-monitor-form.tsx`                  | `tcp-monitor-form.tsx`                                                 |
| Per-project cap         | `WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT` | `WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT` (new, default 50)              |
| Queue                   | `uptime`                                 | `uptime` (shared)                                                      |
| Dispatch                | `resolveExecutor` `http →` HttpExecutor  | `tcp`/`ping →` TcpExecutor                                             |

**Env key added (the only env change):** `WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT`
(`number().default(50)`) — a type-scoped cap counting `tcp` rows, separate from the
browser + http caps because a raw `connect()` is ~free like a `fetch()`.

**No schema change, no migration.** Confirmed `monitors.type` already documents
`'tcp' | 'ping'` as reserved and `monitorExecutions` already has the
`statusCode` (null for tcp) + `resultDetail` (the tcp JSON) columns. The
`type` union in `monitors/types.ts` already listed `"tcp" | "ping"`.

### Files created

- `apps/dashboard/src/lib/monitors/tcp/tcp-run.ts` — pure DI'd TCP check lifecycle; the connect/timeout race, the SSRF re-check, the pass/fail/error model. Documents the ICMP/ping rationale.
- `apps/dashboard/src/lib/monitors/tcp/tcp-executor.ts` — thin adapter wiring `connect()` + the clock + the timeout timer into `runTcpCheck`.
- `apps/dashboard/src/lib/monitors/tcp/host-policy.ts` — `checkTcpHostPolicy`, the bare-host SSRF guard reusing the shared block kernel.
- `apps/dashboard/src/lib/monitors/tcp/cloudflare-sockets.d.ts` — minimal ambient decl for the `cloudflare:sockets` `connect()` (the app's tsconfig narrows `types`, so the global workers-types decl isn't in scope).
- `apps/dashboard/pages/.../monitors/tcp-monitor-form.tsx` — create/edit form (host, port, connect timeout; no assertion builder — a tcp check's only signal is connectivity).
- `apps/dashboard/src/lib/monitors/tcp/__tests__/tcp-run.test.ts` — executor outcome model (pass / connect-throw / opened-reject / timeout / invalid config) + the SSRF property tests (no socket opened to an internal host).
- `apps/dashboard/src/lib/monitors/tcp/__tests__/host-policy.test.ts` — host-policy allowed/blocked/shape cases, mirroring `url-policy.test.ts`.

### Files modified

- `monitor-schemas.ts` — `TcpMonitorConfigSchema` + `parseTcpMonitorConfig`, `TcpResultDetailSchema` + `parseTcpResultDetail`, `CreateTcpMonitorSchema` (added to the discriminated union), `UpdateTcpMonitorSchema`, and `UpdateMonitorInput` now unions `config` over http|tcp.
- `monitors/types.ts` — `TcpResultDetail` interface + `MonitorResultDetail` union; `ExecutionResult.resultDetail` widened to the union.
- `http/http-run.ts` + `tcp/tcp-run.ts` — each pure check now returns a precise `HttpExecutionResult` / `TcpExecutionResult` alias (`resultDetail` narrowed to its own detail type), so callers/tests narrow without a guard while both stay assignable to `ExecutionResult`. (Needed because widening `ExecutionResult.resultDetail` to the union would otherwise break the http test's field accessors.)
- `http/url-policy.ts` — `isBlockedHost` → exported `isBlockedHostname` (shared kernel).
- `executor-registry.ts` — `resolveExecutor` routes `tcp`/`ping → TcpExecutor`.
- `crons/sweep-monitors.ts` — routes `tcp`/`ping` jobs to `queues.uptime`.
- `queues/uptime.ts` — docstring now covers the uptime family (http + tcp/ping).
- `monitor-form-parse.ts` — `formType` returns `"tcp"`; new `tcpConfigFromForm`.
- `monitors-repo.ts` — `createMonitor`/`updateMonitor` write `config` for tcp too; `countMonitors` docstring covers the third cap.
- `env.ts` — `WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT`.
- `pages/.../monitors/[monitorId]/index.server.ts` — loader parses tcp config + reuses the time-based uptime windows for tcp (no response-time trend — a tcp check has no status code); create/update actions gained a `tcp` branch with the tcp cap.
- `pages/.../monitors/[monitorId]/index.tsx` — 3rd `TypeCard` (`?type=tcp`), tcp create/edit form rendering, `TcpConfigSummary` + `TcpExecRow` + `TcpExecDetail` (host:port + connect/total timings, expandable like the http rows).
- `components/monitors/monitor-status.tsx` — `MonTypeGlyph` plug glyph for `tcp`/`ping`.
- `monitors-ui.shared.ts` — `monitorTypeLabel` handles tcp/ping.
- Extended `__tests__/monitor-schemas.test.ts` (tcp create/config/result-detail round-trips, SSRF rejection) and `__tests__/monitor-form-parse.test.ts` (tcp `formType`, `tcpConfigFromForm`, schema round-trip incl. SSRF at the boundary).

## Scope notes — deferred phases NOT implemented

Per the plan and task scope, **Deferred Phases 4–6 were NOT implemented**:
sub-minute scheduling (fan-out `delaySeconds` in `planMonitorSweep`), in-executor
retries (the unused `retryConfig` column / `attempt`), and alerting hooks at
`recordExecutionResult` — all explicitly out of scope. The tcp interval schema
accepts the full preset grid (data-compatible with the later sub-minute phase),
but the v1 UI offers only the `>= 60s` subset, exactly as HTTP does. No new
roadmap files or features were invented.

## A note on the executor's explicit host re-check

`runTcpCheck` re-checks the host before `connect()` as defense in depth, but
because `parseTcpMonitorConfig` already validates through `TcpMonitorConfigSchema`
(whose host refinement runs `checkTcpHostPolicy`), a blocked host is rejected at
the parse step first (→ `null` → terminal "no valid tcp config" error). The
explicit re-check is therefore currently unreachable for any host the schema
rejects — it's a cheap backstop for a future direct-DB write or schema relaxation.
The tests assert the load-bearing SECURITY property (terminal `error`,
`infraError: false`, and `connect()` never called) regardless of which layer
fires. This mirrors HTTP, whose read-path re-check exists only for the _redirect_
case (a host the config-time check never saw); TCP has no redirect, so the
config-schema parse IS its active read-path guard.

## Verification

| Check                                              | Result                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm --filter @wrightful/dashboard run typecheck` | **clean** — exit 0, 0 errors                                                     |
| `pnpm --filter @wrightful/dashboard test`          | **1025 passed** (94 files) — was 1011 before; +14 tcp tests                      |
| `pnpm --filter @wrightful/dashboard run check`     | **0 errors**, 73 warnings (all pre-existing; net −1 vs baseline 74)              |
| `pnpm --filter @wrightful/reporter test`           | **257 passed** (16 files) — contract canary green; reporter wire types untouched |

Monitor-only test run: 139 passed (13 files), incl. the new `tcp-run` (9) +
`host-policy` (4) suites and the extended schema/form-parse tests.

**`WRIGHTFUL_MONITOR_EXECUTOR=stub` and the tcp pipeline:** `stub` only selects the
BROWSER executor in `resolveExecutor`; `tcp`/`ping` (like `http`) always resolve to
their real executor (`TcpExecutor`). So with `stub`, a tcp monitor's job still
flows the full schedule → `uptime` queue → `runMonitorJob` → record pipeline
structurally — but the check itself opens a REAL socket via `connect()` (there is
no tcp stub, exactly as there is no http stub). The pipeline is exercised end to
end; only the network leaf is live. (No live monitor was run as part of this work.)

## Unsure / follow-ups

- `resolveExecutor` is not unit-tested by import anywhere (it pulls `void/sandbox`
  - `cloudflare:sockets`, which the vitest harness can't resolve — the existing
    suite confirms this). The tcp routing is covered indirectly via the pure
    `runTcpCheck` outcome tests + the discriminated-union schema tests, matching how
    the http routing is covered. The plan's "extend executor.test.ts (resolveExecutor
    routes tcp)" could not be done as a direct import without breaking the harness.

## Review + fix

Reviewed across SSRF host-policy, executor correctness, schema/config, dispatch/
settle, and UI. The executor is sound (the SSRF re-check binds before `connect()`
on every run; the timeout race closes the socket on both arms; a synchronous
`connect()` throw and a rejected `socket.opened` both settle `fail`; close errors
are swallowed; no double-settle). The schema (port `int [1,65535]`, bounded
timeout, host refined through `checkTcpHostPolicy`), the per-type/per-project cap
(`WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT` + `countMonitors(scope, type)`), and
dispatch (tcp/ping → `TcpExecutor` → `uptime` queue) are correct. One SSRF gap was
found and fixed:

- **Non-canonical IPv4 SSRF bypass (the http path didn't have this gap).**
  `checkTcpHostPolicy` passed the raw host straight to `isBlockedHostname`, whose
  `parseIpv4` only matches a canonical dotted-quad — so short/decimal/octal forms
  that resolve to internal addresses (`127.1`, `2130706433`, `0177.0.0.1`, `10.0`)
  slipped the literal-IP block set. (The http policy gets normalization for free
  via `new URL()`.) `checkTcpHostPolicy` now rejects any all-digits-and-dots host
  that is NOT a canonical dotted-quad — a real DNS name always carries a
  non-numeric label, so legitimate hosts are unaffected. The guard runs at BOTH
  the write path (the schema host refinement calls `checkTcpHostPolicy`) and the
  read path (the executor's pre-`connect()` re-check). Regression tests added.

Re-verified: typecheck clean, **1026 tests pass** (94 files), `vp check` 0 errors.

> Note: the 5-dimension adversarial-review workflow could not run (session token
> limit), so this review was performed directly against the code; the SSRF and
> executor logic — the highest-risk surfaces — were traced by hand with concrete
> host/port inputs.
