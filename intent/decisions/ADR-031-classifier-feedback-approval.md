# ADR-031: Exact-request classifier review through Support tickets

Status: accepted (2026-10-18), requested by the operator. Extends the frozen core contract with `report_classifier`, `get_classifier_report`, optional `AskEyesInput.classifier_report_id`, and the matching `EyesService` methods. Implemented by T6.62–T6.64 and migration 035.

## Decision

Reuse Support tickets for classifier feedback before a task or worker exists. Store the original normalized Ask and bounded, explicitly untrusted client-reported error. A separate per-card report key deduplicates reports; the original Ask key remains part of the reviewed request.

Only an authenticated operator with the existing same-origin protection can approve or reject. Persist the actor, time, reason and decision. Reporting, checking status and deciding never dispatch, charge or message a worker.

Approval lasts 24 hours and belongs to one authenticated agent and a server SHA-256 fingerprint of the normalized question, location, task type, bounty, deadline, photo requirement and original Ask key. An explicit retry supplies the ticket ID and unchanged original Ask. It may bypass only a classifier-layer refusal; deterministic rules, normal spending checks and balance constraints still apply. A ticket-row lock links approval to one resulting task through the existing posting transaction. A failed post leaves approval unused; repeated successful retries return the same task without a second charge.

## Consequences

The MCP and REST surface gains two tools, for twelve total. The widget preserves the refused request, offers Report and status checks, and enables an explicit approved retry rather than automatic task creation. Support displays the original context and separate Approve/Reject actions without financial controls. Existing worker HELP and dispute behavior remains separate.

Rejected alternatives: a blanket agent exemption, trusting a submitted classifier result as authorization, automatically retrying after approval, or using payout Release/Refund actions for a pre-dispatch refusal.
