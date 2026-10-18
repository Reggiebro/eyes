# Safety before money moves

Every task is checked before any money is held and before any worker sees it. Fast rules run first, then an AI classifier reviews whatever the rules let through. Eyes only takes tasks about public, commercial or civic places. Tasks about homes, specific people, vehicles or faces are refused, and the refusal tells the agent how to rephrase.

## How it works

- `checkRules` uses regular expressions to catch clear cases such as "my ex's house", license plates, "follow her" and "photo of the cashier's face".
- With Cloudflare credentials, Clef blocks only when a blocked category has confidence at least `EYES_CLASSIFIER_BLOCK_MIN` (default `0.95`, finite range `0.5`–`1` inclusive). Otherwise it allows, including uncertain results. Higher values are more permissive; `1` still blocks confidence `1` and never disables deterministic rules.
- `createAssessTask(env, blockMin?: () => Promise<number>)` accepts an optional async threshold getter, read on each classifier assessment. Invalid environment values fail startup; invalid or rejected getter results fail closed.
- Clef provider errors fall back to Claude when `ANTHROPIC_API_KEY` is set. Claude's schema has no numeric confidence: its explicit allow/block result remains authoritative, independently of the Clef threshold. With neither provider configured, only rules run.
- The task is passed to the classifier as data inside `<task>` tags. Any attempt in the task to override the policy is itself blocked.
- Failing closed: if the classifier errors or times out, the task is refused as "temporarily unavailable" and nothing is charged.
- `quote_task` checks the place and returns `allowed: false` with a `reason_if_not`. `ask_eyes` checks the question too and refuses with `unsafe_task` (HTTP 422).
- Widget tool errors display the escaped human message and suggested fix, not the raw JSON response, in both MCP Apps and ChatGPT.

The threshold is a model score, not a calibrated probability or a safety guarantee. In the unchanged 200-fixture evaluation, the demo default `0.95` produced 0 false blocks and 62 false allows (precision `1.000`, recall `0.415`), with no provider failures. The exact YC hackathon question was allowed. The user accepted this demo trade-off; the deterministic rules and fixture labels are unchanged.

## How to try it

Ask a connected agent:

```text
Use Eyes to check whether my ex's car is parked outside her house.
```

The agent gets back `unsafe_task` with a `reason` and a `fix`, for example "Ask about a public place such as a store, cafe, park or transit stop." No bounty is held. To check the rules locally, run `pnpm test:safety`. With an API key set, `pnpm safety:eval` scores the whole pipeline against labelled fixtures.

## Where in the code

- [`packages/safety/src/rules.ts`](../../packages/safety/src/rules.ts): the rules, plus a reason and fix for each category
- [`packages/safety/src/index.ts`](../../packages/safety/src/index.ts): classifier prompt and the fail-closed wrapper
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): where `quote_task` and `ask_eyes` call the check
- [`packages/core/src/errors.ts`](../../packages/core/src/errors.ts): the `unsafe_task` error
- [`evals/safety/`](../../evals/safety/): eval runner and fixtures
