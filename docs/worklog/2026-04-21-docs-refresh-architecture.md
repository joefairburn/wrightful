# 2026-04-21 — Docs refresh: README + ARCHITECTURE + CLAUDE.md

## What changed

User-facing docs had drifted from the current architecture. Refreshed the
top-level README, reporter README, and `CLAUDE.md`, and added a new
`docs/ARCHITECTURE.md` as a one-page orientation for contributors.

## Details

| File                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                   | Replaced "Drizzle ORM on D1" with the Kysely + per-team DO + R2 split. Clarified `WRIGHTFUL_TOKEN` is project-scoped and fixed the `WRIGHTFUL_URL` placeholder.                                                                                                                                                                                                                                                           |
| `packages/reporter/README.md` | Added a **Protocol** section documenting `X-Wrightful-Version: 3` and the 409 behaviour across version mismatches. Noted that `WRIGHTFUL_TOKEN` is project-scoped.                                                                                                                                                                                                                                                        |
| `CLAUDE.md`                   | Updated the project summary and `packages/dashboard` bullet to reflect Kysely + `TenantDO` + control D1 split and Better Auth via `kyselyAdapter`. Added a **Data layer** subsection. Added `tenantScopeForUser` / `tenantScopeForApiKey` to the authz helpers list. Rewrote the **Query scoping rule** to reflect DO-enforced team isolation + within-DO `projectId` filtering. Removed the stale `db:generate` command. |
| `docs/ARCHITECTURE.md`        | New file. One-page orientation: request-flow diagram, storage split (control D1 vs TenantDO vs R2 vs SyncedStateServer), auth systems, route surface, frontend, tooling.                                                                                                                                                                                                                                                  |

## Why

Two recent architectural shifts weren't reflected in the docs:

1. **Per-tenant Durable Objects + Drizzle → Kysely** (`2026-04-20-per-tenant-durable-objects.md`).
2. **Multi-tenancy + Better Auth** (`2026-04-17-multi-tenancy.md`).

Plus smaller gaps: protocol `X-Wrightful-Version: 3`, frontend stack, oxc + tsgo toolchain.
