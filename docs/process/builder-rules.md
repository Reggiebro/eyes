# Builder rules (every builder, every task)

## Before writing code
1. Read your task card in `docs/SPEC.md` §5 and the spec sections it cites.
2. Read the frozen contracts: `packages/core/src/*.ts`, `packages/db/migrations/001_init.sql`, and every ADR in `intent/decisions/`.
3. Touching a sponsor integration? Read its note in `docs/vendor/` first. Never guess a vendor API from memory. If the note does not cover a call, read the installed package's `.d.ts` under `node_modules`, then the vendor doc URL, and write what you assumed in your intent file under "Assumptions".

## Ownership
- Edit only the files your task card owns. Never edit `packages/core/**`, merged migrations, root config (`package.json` scripts, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `playwright.config.ts`), `.github/**`, `.claude/**`, or another builder's directories.
- Adding a dependency to your own package is fine (`pnpm --filter @eyes/<pkg> add <dep>@<exact version>`); commit the lockfile change.
- Need a contract change? Stop. Report the exact proposed diff and why in your final message. Do not make it.

## Code
- TypeScript strict.
  Libraries ship `.ts` source; relative imports use the `.ts` extension.
  Node.js runs them directly with built-in type stripping.
  Type-only imports use `import type`.
- No code comments. Reasoning belongs in your intent file (Decisions, Assumptions, Known gaps).
- Money is integer cents (ADR-001). Errors thrown to agents are `EyesError` from `@eyes/core` with a useful `fix`.
- No secrets in code, tests, fixtures or logs. Adapters read env through their `env` parameter.
- Smallest code that does the job. No abstraction with one caller, no config knob for a constant, no handling for states that cannot occur.

## Tests
- A test must fail if the behavior breaks. Assert behavior, never source text. Skip tests for trivial one-liners.
- Naming: `*.test.ts` unit (no network, no DB), `*.int.test.ts` needs Postgres via `DATABASE_URL`, `*.rules.test.ts` safety rule fixtures, `e2e/*.spec.ts` Playwright.
- Local Postgres: `pnpm db:up` (Docker/OrbStack) then `DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm db:migrate`. If the `eyes-pg` container already runs, reuse it.

## Definition of done
1. `pnpm verify:fast` passes in your worktree. If you touched the database, `DATABASE_URL=... pnpm test:integration` passes too.
2. `intent/<task-id>-<slug>.md` exists (template in SPEC §7), lists every file you changed in `files` (globs allowed), with real verification evidence (commands and results). `status: needs-follow-up` until verifiers pass.
3. `pnpm intent:index` run and `intent/INDEX.md` committed.
4. Commit on your branch `feat/<task-id>-<slug>`, `git push -u origin HEAD`, then open a PR: `gh pr create --title "[<task-id>] <what it does>" --body "<summary, how verified, intent file path>"`. Do not merge. Do not mark the task done.
5. Your final message is one JSON object: `{"task","branch","pr_url","verify_fast":"pass|fail","files_changed":[...],"known_gaps":[...],"questions":[...]}`.

## Fix rounds
When the orchestrator sends verifier findings, fix every blocker and major on the same branch, push, and reply with the same JSON shape. Do not argue with a finding in code; if you think it is wrong, say why in `questions`.
