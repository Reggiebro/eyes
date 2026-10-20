# Architecture

## Request path

The Cloudflare edge forwards requests to the Manufact-hosted MCP/API server when `ORIGIN` is set.
The server calls InsForge Postgres functions through HTTP RPC.
The path is: Cloudflare edge, Manufact MCP/API server, InsForge Postgres.
See [the edge worker](../apps/edge/api/worker.js), [server composition](../apps/mcp/src/main.ts), and [database transport](../packages/db/src/rpc.ts).

`apps/mcp` connects the service, provider adapters, routes, and background expiry and payout loops.
`EyesService` defines the shared service boundary; `packages/engine` implements it.
The server uses direct Postgres instead of InsForge RPC when `DATABASE_URL` is set, including local integration tests.
InsForge also stores photos through the storage adapter in `packages/db`.

## Package dependency map

These are declared workspace dependencies from the package manifests.
Names below omit the `@eyes/` prefix.

- `core` and `ui`: no workspace dependencies.
- `db`: `core`.
- `engine`: `core`, `db`.
- `comms`, `safety`, and `verify`: `core`.
- `payments`: `core`, `ui`.
- `mcp`: `comms`, `core`, `db`, `engine`, `payments`, `safety`, `ui`, `verify`, `web-dashboard`.
- `web-dashboard`: `core`, `db`; development also uses `engine`.
- `cli`: `core`; development also uses `db`, `engine`, `mcp`.
- `web-worker`: `core`, `ui` as development dependencies.
- `web-landing`: `ui` as a development dependency.
- `widget-task-card`: `core` as a development dependency.

The mobile app has no declared workspace dependencies.
Provider adapters supply messaging, email, payments, safety assessment, and photo verification to the server composition.

## One-transaction money rule

Keep each money-related database transition in one Postgres function and one transaction.
Commit its task state, ledger entries, and balance changes together; never split them across application-side writes.
[ADR-003](../intent/decisions/ADR-003-seams-and-ownership.md) defines this boundary.
[The engine migration](../packages/db/migrations/002_engine.sql) implements top-up credit and task escrow with PL/pgSQL functions.
The database adapter invokes each function through one SQL statement or one InsForge RPC request.

This rule covers database state, not an atomic transaction with Stripe.
The payments adapter performs external payment operations; the server separately retries payouts through the engine.
