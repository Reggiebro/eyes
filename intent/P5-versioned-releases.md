---
task: P5 - Versioned releases
files:
  - .github/workflows/release-please.yml
  - release-please-config.json
  - .release-please-manifest.json
  - scripts/ci-scope.ts
  - scripts/ci-scope.test.ts
  - CONTRIBUTING.md
---

## Why

Close #208 with release pull requests, GitHub releases, and tags from conventional commits.
Track the root package from 0.1.0 and keep breaking changes below 1.0 on the minor version.
Keep the existing changelog and use only the default GitHub token.
Do not deploy, publish packages, push images, or change repository settings.
Ignore generated release metadata when selecting affected code checks without hiding package or source changes.

## Verification

Run the CI scope regression before and after the change.
Run lint, typecheck, affected unit, contract, and integration checks, and the intent checker.
Validate the workflow and exercise release-please locally without creating a release or tag.
Compare the Sentrux score and review the diff once with ponytail-review.
Use GitHub CI for the full suite.
