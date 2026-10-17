# Eyes

Eyes lets any AI agent pay a nearby human a few dollars to check something in the physical world. The agent is the customer; the human is the API.

Built at YC's "Make Something Agents Want" hackathon (Oct 17-18, 2026).

- Spec: [docs/SPEC.md](docs/SPEC.md)
- Why every file exists: [intent/INDEX.md](intent/INDEX.md)
- Status: [STATUS.md](STATUS.md)

## Develop

```sh
pnpm install
pnpm db:up
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm db:migrate
pnpm verify:fast
```
