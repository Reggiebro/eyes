---
task: S8-photo-check-budget
files:
  - packages/verify/src/index.ts
  - packages/verify/src/index.test.ts
  - intent/S8-photo-check-budget.md
  - intent/INDEX.md
---

## Why

Issue #103: photo download and the first checker could consume the full 25-second verification budget.
Share one 8-second deadline across the photo download and Clef request, including response bodies.
This leaves Claude its existing 15-second timeout and 2 seconds of margin.
The total budget, blocked categories, refusals, and photo release rules do not change.

## Verification

The regression uses fake timers and stalled photo or Clef requests, including a 6-second photo download.
Claude takes another 14,999 milliseconds and verification must approve within 23 seconds.
Both cases fail before the fix and pass after it.
Run the verifier unit tests, contract tests, and engine photo-moderation integration tests.
Run lint, typecheck, intent validation, and the Sentrux gate.
