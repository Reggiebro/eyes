---
task: P2 - CI quality gates
files:
  - .github/workflows/ci.yml
  - .github/workflows/claude-verifier.yml
  - .github/workflows/live-smoke.yml
  - .github/workflows/safety-llm-eval.yml
  - .github/actions/setup/action.yml
  - .github/dependabot.yml
  - .gitignore
  - .sentrux/baseline.json
  - scripts/check-quality.ts
  - scripts/check-quality.test.ts
  - CONTRIBUTING.md
---

## Why

Close #194 with separate audit, sentrux, actionlint, and docker-build jobs.
Pin third-party actions and request weekly dependency updates without changing repository settings.
Leave mobile out under the task's failing-gate exception: its isolated typecheck imports `vitest`, which only the root workspace installs.
Build the Docker image without a registry login, push, or deployment.

Sentrux 0.5.7 uses the baseline saved from main at `cdca112b31d8911801de6f1d8c09cea6357d8eb9`, with quality 6494.
Require the baseline from the first run, reject DEGRADED, and independently reject a quality drop over 250 points.
The numerical limit does not override a DEGRADED verdict for a smaller drop or another structural regression.
Missing results and tool failures must not pass the gate.
Only the baseline belongs in version control; exclude local Sentrux caches.

## Verification

Run the threshold regression, the existing CI scope tests, lint, typecheck, and affected contract and integration tests.
Run the real Sentrux comparison, production audit, and actionlint locally.
Verify the mobile failure in an isolated copy without root dependencies.
Use GitHub CI to verify the Docker build because this host has no Docker runtime.
