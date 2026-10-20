---
task: C6-phone-trunk-zero
files:
  - packages/core/package.json
  - packages/core/src/phone.ts
  - apps/web/worker/src/join.ts
  - apps/web/worker/src/join.test.ts
  - apps/mcp/src/ops-auth.ts
  - apps/mcp/src/ops-auth.test.ts
---

## Why

Issue #127 reports that `+44 (0) 20 7946 0958` retains the optional trunk zero.
The join form and ops authentication contain separate copies of the same normalizer.
Use one browser-safe helper at `@eyes/core/phone` and remove `(0)` immediately after an explicit country code before removing punctuation.
Preserve US handling and significant zeros such as `+39 06 6982 0000`.
Do not infer optional zeros without parentheses or add support for the `00` international prefix.
The join form's markup and styling do not change.

## Verification

The regression failed before the fix in three normalization cases, join submission, and ops sign-in.
Run the join and ops authentication unit tests, core contract tests, and worker setup integration tests.
Run lint, typecheck, the worker build, intent checks, and the Sentrux gate.
