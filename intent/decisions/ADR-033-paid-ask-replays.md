# ADR-033: Replay paid asks before policy checks

Status: accepted

## Decision

Look up an authenticated agent's idempotency key before classifier approval, safety, spending policy, or worker discovery.
Compare the retry with the stored question, type, resolved place, bounty, photo requirement, and original duration.
Reject changed parameters with `idempotency_conflict`.
Keep the transactional key check in `eyes_post_task` to protect concurrent first calls.

Return the stored task status and the held amount from its escrow, release, fee, and refund ledger entries.
A replay sends no offers and moves no money.
Expose all task statuses in the REST and MCP ask response schemas.
Direct clients to `get_task` for a replay that is no longer dispatched.

## Consequences

Owner policy changes and new safety decisions cannot turn an existing paid ask into a new purchase.
New keys still pass every current policy check.
String locations still require geocoding to compare the resolved place, as they do in the existing transactional key check.
The read RPC restricts the lookup to the authenticated agent ID supplied by the server.
The append-only migration does not change stored task or ledger data.
