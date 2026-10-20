---
task: S2
title: Reject sub-cent bounty and policy inputs
files:
  - packages/core/src/util.ts
  - packages/core/src/util.cents.test.ts
  - packages/engine/src/index.ts
  - intent/decisions/ADR-042-whole-cent-inputs.md
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
status: done
---

## Why

Issue #117 reports that rounding caller amounts silently changes bounties and policy limits.
Reject sub-cent inputs before money conversion.
Keep the contributor's validation approach and tests.

## What changed

Validate bounty and policy amounts before converting USD to cents.
Preserve the input type when validation returns the unchanged value.
Use `EyesError` with `invalid_input` so invalid amounts return HTTP 400.
Keep the existing rounding behavior for amounts outside these input boundaries.
Pin the MCP CLI's Vite dependency to the existing patched workspace version, 8.3.4.
Its exact 8.0.16 dependency failed the CI audit with three security advisories.

## Verification

Run the core amount unit tests and contract tests.
Run the engine integration tests with the isolated test database.
Run lint, typecheck, the intent check, and the Sentrux gate.
Run the production dependency audit after refreshing the lockfile.
