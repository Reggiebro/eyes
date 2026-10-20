# Contributing

Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems through [SECURITY.md](SECURITY.md), not public issues.

## Setup and checks

Use Node.js 24.2 or later and pnpm 11.18.0.
Install dependencies from the repository root:

```sh
npx -y pnpm@11.18.0 install
pnpm verify:fast
```

If `pnpm` is not installed, replace `pnpm` in each command with `npx -y pnpm@11.18.0`.
`verify:fast` runs lint, typecheck, unit, contract, safety, and intent checks.
The commands are defined in [package.json](package.json).

For integration tests, start a local Postgres 17 database with Docker:

```sh
pnpm db:up
export DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes
pnpm db:migrate
pnpm test:integration
```

Without Docker, provide a local Postgres server at that address.
Use a disposable database server, never production.
The test user must create and drop databases.
[scripts/int-db.ts](scripts/int-db.ts) creates a separate database for each integration test file and drops it afterwards.

Run `pnpm coverage:all` for the combined coverage gate.
[CI](.github/workflows/ci.yml) measures affected source files on pull requests and the full configured source set on full runs.
Each included file needs 95% statement, branch, function, and line coverage, as defined in [vitest.config.ts](vitest.config.ts).
CI skips code checks for documentation-only changes; intent and secret checks still run.

## Intent and architecture decisions

For changes under `apps/`, `packages/`, `cli/`, `scripts/`, or `db/`, add or update an `intent/*.md` file.
List the changed paths under `files`, set `task`, and include `## Why` and `## Verification` sections.
See [this intent example](intent/S6-https-security-headers.md) and [the checker](scripts/check-intent.ts).

Add an ADR under `intent/decisions/` when changing core contracts or migrations.
The checker requires an ADR for edits to existing files under `packages/core/src/` or `packages/db/migrations/`.
See [ADR-003](intent/decisions/ADR-003-seams-and-ownership.md) for the service and transaction boundaries.
Run `pnpm intent:index` after intent changes and commit any updated `intent/INDEX.md`.

Keep migrations append-only.
Add a new numbered SQL file under `packages/db/migrations/`; do not edit an applied migration.
Check the latest main branch before selecting the next number.
The migration runner applies files in filename order and records applied names.

## Public documentation and pull requests

Regenerate public API documentation after changes to its source:

```sh
pnpm --filter @eyes/cli gen:docs
```

Commit the resulting `docs/public/` changes rather than editing generated files by hand.
Use conventional commit and pull request titles, such as `fix(engine): preserve retry results` or `docs: add project policies`.
Keep each pull request focused, link its issue, and state which checks passed.
