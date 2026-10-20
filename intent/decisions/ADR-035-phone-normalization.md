# ADR-035: Shared phone normalization

## Decision

Expose `toE164` through the browser-safe `@eyes/core/phone` entry point.
Both the join form and ops authentication use it.
Do not import the core barrel into the browser: its utilities use `node:crypto`.

Remove only an explicit `(0)` immediately after a `+` country code of one to three digits.
Keep the existing digit cleanup, US default, and format validation.
A significant zero in `+39 06 6982 0000` remains unchanged.
An unmarked zero in `+44 020 7946 0958` also remains unchanged; this helper does not implement country-specific numbering plans.
The `00` prefix remains unsupported.

## Consequences

Issue #127 is fixed in join submission, ops code requests, ops code verification, and ops allowlist additions.
The helper adds no dependency and does not change the server's `Phone` schema or stored records.
