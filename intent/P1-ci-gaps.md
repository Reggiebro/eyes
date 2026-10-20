---
task: P1-ci-gaps
files:
  - .github/actions/setup/action.yml
  - .github/workflows/ci.yml
  - .github/workflows/claude-verifier.yml
  - playwright.config.ts
  - vitest.config.ts
  - scripts/ci-scope.ts
  - scripts/ci-scope.test.ts
  - apps/web/dashboard/src/ops-view/actions.ts
  - apps/web/dashboard/src/ops-view.gen.js
  - README.md
---

## Why

Close #132 by running dashboard and landing browser tests with the existing web suite scope.
Use Node 26 in CI, matching the production Docker image.
Exclude generated MCP build output from coverage.
Give the AI verifier 30 turns instead of 20.
The current widget metadata test uses WIDGET_URI and no longer reads a build manifest, so it needs no change.
The newly enabled classifier browser test exposed a dialog closing during a pending approval.
Block native dialog cancellation while the shared action request runs.

## Verification

Run the dashboard and landing Playwright projects through the root configuration.
Run lint, typecheck, scope and MCP server unit tests, contract tests, and affected integration tests.
Check that dashboard and landing paths select the web suites and generated MCP output does not select coverage.
Run the Sentrux comparison and the CI checks on the pull request head.
