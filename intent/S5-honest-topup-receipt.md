---
task: S5 - Honest top-up receipt (#122)
files:
  - packages/payments/src/index.ts
  - packages/payments/src/index.test.ts
  - apps/mcp/src/server.test.ts
---

## Why

The public `/topup/done` page displays an amount from `amount_cents` in the URL.
Anyone can change that value and create a false receipt.
The page will show no amount, and Checkout will stop adding an amount to its return URL.
The existing simulated-payment notice and webhook credit flow remain unchanged.
No Stripe session lookup or live API call is needed.

## Verification

The HTTP regression test requests a forged amount and rejects its display.
The existing Stripe transport fixture checks the Checkout return URL without an amount.
Run lint, typecheck, unit, contract, and integration tests, plus the intent and Sentrux gates.
Capture the actual route HTML with fake providers before and after the fix at desktop and phone widths.
