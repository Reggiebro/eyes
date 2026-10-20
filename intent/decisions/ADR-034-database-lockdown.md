# ADR-034: Lock down ops tables and remove banned-worker devices

Status: accepted

## Decision

Enable row-level security on events, tickets, ops_allowlist, and ops_codes without client policies.
Revoke all table privileges from PUBLIC and from existing anon and authenticated roles.
Keep the server connection's existing owner or bypass access.

Replace eyes_confirm_fraud in the same append-only migration.
Delete the banned worker's registered devices beside the existing location-token deletion.
Keep the worker-first lock order, refund transaction, replay behavior, and function permissions unchanged.
Take a shared worker lock during device registration to serialize its eligibility check with a fraud ban.

## Consequences

Client roles cannot access these tables, including after accidental table grants when row-level security still applies.
Server reads and writes continue to work.
A failed fraud transaction also rolls back device deletion.
Other workers keep their devices, and STOP continues to remove devices as before.
This change does not remove devices for historical bans or change the Apple developer account.
