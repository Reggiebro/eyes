---
task: C1
title: Check the typed place in quotes and asks
status: done
files:
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - docs/features/safety.md
  - intent/C1-place-check-parity.md
  - intent/INDEX.md
---

## Why

Issue #116 reports that a map label can hide private-place details from `quote_task`.
Issue #118 item 2 reports that an inconclusive safety check can replace a location error with advice to rephrase the question.

## Behavior

Use one shared assessment path for the typed place and the resolved map label.
Check the typed place with rules only, then check the map label with the original question for `ask_eyes`.
Keep quotes free of classifier calls and avoid an extra classifier call for asks.
Keep a real safety refusal when a place lookup fails.
Return the existing `location_not_found` error and location guidance when the fallback classifier has no specific blocked category.
Keep classifier approvals subject to place rules and preserve paid-ask replay behavior.

No public schema, error code, migration, or generated contract changes are needed.
The remaining items in #118 stay outside this change.

## Verification

The focused regression run failed before the fix in four cases: two typed private places and two inconclusive lookup checks.
The place matrix checks typed private places, a private map label, and an accepted public place through quotes and asks.
The rejection checks also verify that no task or charge is created.
The existing test keeps the hard safety refusal on a failed lookup.
Run the engine and classifier-report integration files against isolated databases on the approved local Postgres server.
Run lint, typecheck, safety unit and rules tests, server unit tests, and the core contract test.
Run a separate REST smoke check for accepted places, private places, and failed lookups.
