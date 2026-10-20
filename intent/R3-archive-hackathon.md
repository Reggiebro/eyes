---
task: R3
files:
  - .claude/agents/integration-verifier.md
  - README.md
  - docs/CONNECT.md
  - docs/DEPLOY.md
  - docs/SPEC.md
  - docs/archive/hackathon/DEMO.md
  - docs/archive/hackathon/PLAN.md
  - docs/archive/hackathon/README.md
  - docs/archive/hackathon/STATUS.md
  - docs/archive/hackathon/SUBMISSION.md
  - docs/archive/hackathon/hackathon.md
  - docs/manufact/README.md
  - docs/vendor/blaxel.md
  - intent/C8-independent-expiry.md
  - intent/INDEX.md
  - intent/R3-archive-hackathon.md
  - intent/T0.1-vendor-notes.md
  - intent/T0.2-scaffold-ci.md
  - intent/T0.4-process.md
  - intent/T2.3b-smoke-live.md
  - intent/T4.1-hardening.md
  - intent/T4.11-honest.md
  - intent/T4.13-consistency.md
  - intent/T4.19-ops-dashboard.md
  - intent/T4.22a-ax.md
  - intent/T4.23-inkbox-shared-line.md
  - intent/T4.24-simulated-payout-honesty.md
  - intent/T4.29-sandbox.md
  - intent/T4.30-widget.md
  - intent/T4.31-tool-hints.md
  - intent/T5.1-docs.md
  - intent/T5.2-docs.md
  - intent/T5.3-live-facts.md
  - intent/T5.4-demo-plan.md
  - intent/T6.19-vision-is-moderation.md
  - intent/T6.30-ux-fixes.md
  - intent/T6.32-ops-host-and-tables.md
  - intent/T6.42-worker-tasks-on-me.md
  - intent/T6.63-classifier-feedback-approval.md
  - intent/T6.65-answer-acceptance.md
  - intent/decisions/ADR-010-blocking-vs-deferred-findings.md
  - intent/verdicts/T1.5-PR7-r7.md
  - intent/verdicts/T3.6-PR50.md
  - intent/verdicts/T4.1-PR37.md
  - intent/verdicts/T4.10-PR53.md
  - intent/verdicts/T4.13-PR60.md
  - intent/verdicts/T4.14-PR61.md
  - intent/verdicts/T4.19-PR67.md
  - intent/verdicts/T4.22a-PR73.md
  - intent/verdicts/T4.23-PR74.md
  - intent/verdicts/T4.24-PR75.md
  - intent/verdicts/T4.3-PR48.md
  - intent/verdicts/T5.1-PR41.md
  - intent/verdicts/T5.2-PR69.md
  - scripts/archive-links.test.ts
  - scripts/ci-scope.test.ts
---

# Archive hackathon records

## Why

Keep the hackathon records separate from current documentation without losing their history or links.

## What

Move five records with `git mv` and update their references throughout the repository.
Only path corrections change the archived records and the Manufact evidence README.
Add an archive description and a regression check for local archive links.

## Verification

Run the archive navigation regression and CI scope tests, lint, typecheck, contract tests, and the intent check.
The archive test fails before the move because the archive does not exist.
Check all five old filenames throughout the repository, including scripts, workflows, public docs, and agent instructions.
