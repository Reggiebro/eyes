---
task: S4
title: Lock down ops tables and remove devices after confirmed fraud
files:
  - packages/db/migrations/041_database_lockdown.sql
  - packages/db/src/lockdown.int.test.ts
  - packages/engine/src/engine.int.test.ts
---

## Why

Issue #125 leaves events, tickets, ops_allowlist, and ops_codes without row-level security.
Issue #124 leaves registered devices attached to a worker after a confirmed fraud ban.

## What

Enable row-level security and revoke PUBLIC, anon, and authenticated table access in one append-only migration.
Keep the existing server access and fraud transaction, including its locks and refund rules.
Delete the banned worker's devices within that transaction.
Lock the worker eligibility check during device registration so a concurrent ban cannot leave a new device behind.
Keep STOP behavior unchanged and preserve other workers' devices.
See [ADR-034](decisions/ADR-034-database-lockdown.md).

## Verification

Before the fix, the row-security regression failed for all four tables.
The fraud regression also failed because both banned-worker devices remained.
The focused checks pass after the migration.
Role checks exercise SELECT, INSERT, UPDATE, and DELETE for anon, authenticated, and a non-superuser server role with BYPASSRLS.
They also test row-level security after table grants are restored within a rolled-back test transaction.
All database checks use isolated databases on the local integration server.
The concurrent-registration regression also failed before the worker eligibility check acquired a shared lock.
After the fix, 104 integration tests, 16 focused unit tests, and 12 contract tests pass.
Lint, typecheck, and intent checks pass; lint reports only existing CSS warnings.
Sentrux passes at 6503 against the 6501 baseline.
A standalone local database smoke confirms the refund, device deletion, other-worker isolation, replay, and all four row-security flags.
