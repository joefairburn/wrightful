# 2026-05-02 — Cut DO `initialize` contention (worker-side + DO-side)

## What changed

Cloudflare observability for the production worker (`bumper-wrightful`) showed dashboard navigations regularly stalling for 6+ seconds, with one outlier at 99 seconds. Trace `78aaaddbdc3b13e0347fd23f67b7c235` is representative: span `9dae7ae159df9a52` is a `ControlDO.initialize` RPC with `wall_time_ms = 88` but `durationMS = 6254` — i.e. 6,166 ms of pure DO-input-queue wait. Same pattern on `TenantDO.initialize` (9 ms wall, 6,504 ms duration) in the same trace, and across the 30 slowest DO calls in the past 24 h.

Two compounding problems caused this; both are fixed here.

### 1. rwsdk's `createDb` fires a redundant `stub.initialize()` per query

`node_modules/rwsdk/dist/runtime/lib/db/createDb.js:13`:

```js
stub.initialize();                     // fire-and-forget RPC
return stub.kyselyExecuteQuery(...);   // separate RPC; DO calls initialize() internally anyway
```

Two RPCs land on the singleton DO per Kysely call, both queue at the input gate. The `kyselyExecuteQuery` path inside `SqliteDurableObject` (`SqliteDurableObject.js:38`) already does `await this.initialize()` itself — so the worker-side fire-and-forget is pure overhead.

**Fix:** vendor a small worker-side dialect at `packages/dashboard/src/lib/db/create-do-db.ts` (`createDoDb`) that only calls `stub.kyselyExecuteQuery(...)`. `getControlDb()` and `getTenantDb()` now use it instead of `rwsdk/db`'s `createDb`. Halves RPC volume to both DOs.

### 2. `SqliteDurableObject.initialize()` races on cold start

`SqliteDurableObject.js:19`:

```js
async initialize() {
  if (this.initialized) return;
  const migrator = createMigrator(...);
  const result = await migrator.migrateToLatest();   // ← await
  if (result.error) { ... }
  this.initialized = true;                            // ← only set AFTER the await
}
```

Cloudflare DO input gates only block re-entry around storage I/O, not at the start of an RPC. When N concurrent RPCs hit a freshly-evicted DO:

1. RPC #1 reads `this.initialized` → false → starts the migrator → awaits storage.
2. While #1 is awaiting, the input gate opens; RPCs #2…N each also read `this.initialized` → still false → each independently runs the migrator.
3. All N migrators race to acquire the `__migrations_lock` row, serialising at the storage layer instead of the input gate.

That's why every slow `ControlDO.initialize` span shows ~88 ms wall — the in-memory short-circuit is unreachable under concurrency. Each concurrent cold-start RPC pays the full migration cost.

**Fix:** add `void ctx.blockConcurrencyWhile(() => this.initialize())` at the end of both `ControlDO` and `TenantDO` constructors. `blockConcurrencyWhile` queues all incoming events until its callback resolves, so migrations run exactly once per DO instance and every subsequent RPC's internal `await this.initialize()` hits the `this.initialized = true` short-circuit.

## Code changes

| File                                                    | Change                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/dashboard/src/lib/db/create-do-db.ts` _(new)_ | Local worker-side Kysely dialect over a DO RPC. Only calls `stub.kyselyExecuteQuery`. |
| `packages/dashboard/src/control/internal.ts`            | `getControlDb()` switched from `rwsdk/db`'s `createDb` to `createDoDb`.               |
| `packages/dashboard/src/tenant/internal.ts`             | `getTenantDb()` same switch.                                                          |
| `packages/dashboard/src/control/control-do.ts`          | Constructor now wraps `this.initialize()` in `ctx.blockConcurrencyWhile`.             |
| `packages/dashboard/src/tenant/tenant-do.ts`            | Same constructor change.                                                              |

`batchControl` / `batchTenant` and other places that already call `await this.initialize()` are unchanged — after these fixes those calls are essentially in-memory boolean reads.

## Why the user-visible improvement should be ~10×

Before: 5 concurrent users × ~3 Kysely calls each = 15 Kysely calls × 2 RPCs = 30 RPCs at ControlDO. Without the input-gate guard, ~30 concurrent migrators race at ~88 ms wall each, serialised at storage. That produces the 6-second waits we see.

After:

- Halved RPC volume (1 RPC per Kysely call).
- Migrations run exactly once per DO instance, paid at construction. All other `initialize` calls are <1 ms in-memory checks.
- Worst-case cold-DO concurrent burst: 88 ms paid once for migrations + ~5 ms per query queued behind it. 5 users × 1 query = 88 + ~25 ms ≈ 110–150 ms.

Not yet implemented (optional follow-ups):

- **Chunked `sweepStuckRuns`** to release the TenantDO between batches. Observability shows one cron sweep took 11.2 s, which holds that team's TenantDO and stalls dashboard requests for that team during the cron window.
- **Sign team membership into the session cookie** (extending the better-auth cookie cache pattern from worklog 2026-04-30) so `loadActiveProject` doesn't need a ControlDO RPC at all on the hot path.

## Verification

| Check                                          | Result                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm --filter @wrightful/dashboard typecheck` | Clean                                                                                                |
| `pnpm --filter @wrightful/dashboard test`      | 167 / 167 passed                                                                                     |
| `pnpm lint`                                    | 31 warnings, 0 errors (1 new warning: unavoidable `unknown → QueryResult<R>` cast on the RPC bridge) |

After deploy, confirm via Cloudflare observability:

1. Filter on `$workers.scriptName = "bumper-wrightful"` AND `$metadata.duration >= 1000`. The recurring `ControlDO.initialize` / `TenantDO.initialize` entries with ~88 ms wall and multi-second durations should drop to near zero.
2. p95 of `ControlDO.initialize` `$metadata.duration` should fall to single-digit ms (in-memory short-circuit).
3. Dashboard nav timings (TTFB on `/t/:team/p/:project` and siblings) should drop into the ~150 ms range outside cold-cron windows.
4. The 99-second outliers on `ControlDO:jsrpc` should not recur — they were tail effects of the same queue-pile-up.

If the cron's `sweepStuckRuns` is still creating periodic 5-min stalls, prioritise the chunked-sweep follow-up.
