---
task: C5 - Health check sees the database (#110)
files:
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - apps/mcp/src/http.test.ts
  - apps/mcp/src/ops-host.test.ts
  - apps/mcp/src/health.int.test.ts
  - docs/DEPLOY.md
---

## Why

The static health response hides database outages from the Cloudflare monitor.
Run the existing indexed agent-key lookup with a fixed non-user key.
A missing agent is healthy: the read succeeded without writing data.
Keep the monitor's successful `ok`, `providers`, and `db` fields unchanged.
Return only `{ "ok": false }` with HTTP 503 when the read fails or takes two seconds.
The response deadline does not cancel the underlying database operation.
Concurrent probes share one unfinished read so a blocked database cannot accumulate reads from repeated health requests.

## Verification

The route regression tests cover a healthy empty lookup, a database error, and a read that never settles.
All three tests failed against the original static route and pass with the database check.
The Postgres integration tests exercise an empty database, a failed lookup, a blocked read, and recovery.
The concurrency regression checks that overlapping requests share a blocked read and start a new read after recovery.
Run the existing server, HTTP, ops-host, and Cloudflare monitor tests to check compatibility.
