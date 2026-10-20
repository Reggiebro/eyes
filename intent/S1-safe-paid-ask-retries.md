---
task: S1
title: Safe retries of a paid ask
status: done
files:
  - packages/db/migrations/039_task_by_key.sql
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/engine/src/engine.adversarial.int.test.ts
  - packages/core/src/schemas.ts
  - packages/core/src/__snapshots__/core.contract.test.ts.snap
  - apps/mcp/src/server.ts
  - docs/public/openapi.json
  - docs/public/llms-full.txt
---

## Why

Issues #106 and #105 break safe retries of an existing paid ask.
A newer owner policy or safety decision can reject a retry before the existing task lookup.
A cancelled task replay also reports a new dispatch and held money after the refund.

## Behavior

Read the agent-scoped idempotency key before policy checks.
Return the stored task only when the original parameters match.
Keep the transactional lookup for concurrent first requests.
Build replay responses from the stored status and task ledger, without another charge or worker message.
Keep current policy checks for new keys.
Allow stored task statuses in REST and MCP responses and refresh the generated public contracts.
See [ADR-033](decisions/ADR-033-paid-ask-replays.md).

## Verification

Five focused Postgres integration checks cover tightened owner limits, changed safety policy, and a cancelled task replay.
Four checks failed before the fix; the daily-cap replay already passed through the transactional lookup.
The checks verify one task, one escrow entry, unchanged balances, no duplicate offer, and parameter conflict rejection.
The cancelled replay must pass the output schema with status `refunded` and zero held funds.
The lifecycle and concurrent retry checks also verify claimed and paid responses, held funds, and equal concurrent replay results.
Run lint, typecheck, unit, contract, safety, integration, and intent checks before delivery.
Run a separate REST smoke scenario against an isolated local Postgres database.
