---
task: S10 - Recover payout setup links (#134)
files:
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - apps/web/worker/src/me.ts
  - apps/web/worker/src/me.test.ts
---

## Why

Opening a payout link creates a Stripe account before the worker completes onboarding.
START, HELP, and the setup page must keep offering the link while released earnings remain unpaid.
The checklist now respects that recovery link even when an account exists.
Workers with an account and no unpaid earnings keep the completed state.
This uses the pending-earnings rule requested in issue #134; it does not infer Stripe capability status.

## Verification

The integration regression reproduces the missing START link before the fix.
It checks START, HELP, the setup API, reuse of the existing fake account, and removal of the link after onboarding pays the earnings.
The checklist regression reproduces the hidden recovery action before the UI fix.
Use the existing fake payment provider; do not call live Stripe APIs.
Run the worker checklist unit tests, engine integration tests, payment unit tests, contract tests, lint, typecheck, and the Sentrux gate.
