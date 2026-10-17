# ADR-001: All money is integer cents

Status: accepted (G0, 2026-10-16)

## Context
Eyes escrows, releases, refunds and pays out small amounts ($3.00 bounty + $0.50 fee). Float USD math drifts (0.1 + 0.2), and Stripe amounts are integer minor units.

## Decision
- Every stored and computed amount is an integer number of cents (`*_cents`, Postgres `bigint`).
- USD appears only at the agent-facing edge (`*_usd` fields in tool IO), converted with `usdToCents` / `centsToUsd` in `@eyes/core`.
- Ledger rows always carry a positive `amount_cents`; the `type` carries direction.
- `ledger_once_per_task` (unique `task_id, type`) makes a second escrow, release, refund, payout or fee for the same task impossible at the database level, so escrow cannot double-release even if application code retries.
- `ledger_stripe_ref` (unique `type, stripe_ref`) makes Stripe webhook redelivery idempotent for top-ups.
- `agents.balance_cents >= 0` is a check constraint, so overspend fails in the database, not just in code.

## Consequences
Builders never accept or emit float money internally. Verifiers treat any `*_usd` arithmetic inside the engine as a blocker.
