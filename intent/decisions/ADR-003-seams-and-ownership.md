# ADR-003: Service seam, route ownership and task-graph adjustments

Status: accepted (G0, 2026-10-16)

## Context
Nine builders run in parallel with disjoint file ownership. The prompt's ownership split leaves three shared-file collisions: (1) webhook routes live in `apps/mcp` but are owned by comms and payments, (2) the ledger is owned by payments but escrow must commit atomically with task creation, which is engine/db work, (3) nobody owns geocoding or photo storage.

## Decision
1. `EyesService` in `packages/core/src/service.ts` is the only seam between transports (MCP, REST, email, CLI, worker web) and the engine. Transports never touch the database.
2. Each vendor package exports Fetch-standard Hono sub-apps (`inkboxRoutes`, `primitiveRoutes`, `stripeRoutes`) and adapter factories that read their own env vars. `apps/mcp` only mounts and composes; it never edits vendor files and vendor builders never edit `apps/mcp`.
3. Ledger SQL (escrow, release, refund, fee rows, balance changes) lives with the engine in `packages/db` migrations as plpgsql functions, so each state transition is one transaction. `payments` owns the Stripe adapter: Checkout top-ups, Connect onboarding, transfers, webhook verification, and the `/topup/:token` and `/w/connect/:token` redirects.
4. Real geocoding (`Geo`) is owned by `mcp-builder` in `apps/mcp/src/geo.ts`. InsForge photo storage (`Storage`) and the InsForge database transport are owned by `engine-builder` in `packages/db`.
5. Turbo is dropped. One root `tsc`, one root `vitest` (projects: unit, contract, integration, safety) and one root `biome` cover the workspace, and libraries ship TypeScript source run directly by Node 24 type stripping. There is no per-package build graph for turbo to cache.
6. InsForge exposes no direct Postgres connection string, only PostgREST records, RPC and raw SQL over HTTP (docs/vendor/insforge.md). Atomic transitions are therefore plpgsql functions called over RPC in production and over `postgres` in CI and local dev (`DbConfig.kind`). There is no in-memory database fake: CI runs real Postgres.

## Consequences
Contract changes to `EyesService`, provider interfaces or route factory signatures need a new ADR and a notice to every running builder.
