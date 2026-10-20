---
task: D1
title: Correct deployment and runtime documentation
files: [docs/DEPLOY.md, .env.example, CONTRIBUTING.md, docs/process/builder-rules.md, docs/public/llms.txt, docs/public/llms-full.txt, intent/T0.2-scaffold-ci.md, intent/T2.3-deploy.md, intent/T2.3b-smoke-live.md, intent/decisions/ADR-003-seams-and-ownership.md, intent/verdicts/T2.3b-PR26.md]
---

## Why

Issue #133 identifies machine-specific deployment instructions and outdated runtime and environment documentation.
The deploy script and deployment branch remain unchanged.

## Changes

- Replace laptop paths and account IDs with operator-supplied values; keep the historical recovery procedure marked as historical.
- Use the ordered migration directory instead of a fixed applied range; repository files do not establish production database state.
- Match runtime guidance to Node.js 26 in CI and Docker; retain historical verification without an outdated runtime recommendation.
- Remove the unused `EYES_SHORTCUT_URL` example and document the `/install` fallback when `EYES_TESTFLIGHT_URL` is unset.
- Regenerate public documentation from `docs/public/llms.txt`.

## Verification

- Five temporary documentation checks failed before these corrections and passed afterward.
- `node cli/src/main.ts --help` ran on Node.js 26.10.0.
- `bash -n` accepted all three deployment shell examples; no deployment command ran.
- `pnpm lint` and `pnpm typecheck` passed, using `npx -y pnpm@11.18.0`; lint reported 16 existing CSS warnings.
- Documentation and smoke unit tests passed: four tests in `cli/src/docs.test.ts` and `scripts/smoke-live.test.ts`.
- `pnpm test:contract` passed all 12 tests.
- Three existing install-link cases in `packages/engine/src/engine.int.test.ts` passed on `postgres://postgres:eyes@127.0.0.1:54329/eyes`.
- `pnpm intent:index` left the index unchanged; `pnpm intent:check` passed.
- Sentrux reported no degradation: 6492 before and after.

## Deferred work

Issue #133 stays open.
Duplicate ADR and T6.36 IDs need a separate PR, including updated references and the generated index.
The `AGENTS.md` rewrite waits for the owner decision requested in #180.
Personal screenshot paths in historical intents remain outside this split.
Keep code comments; large image cleanup belongs to a later PR.
