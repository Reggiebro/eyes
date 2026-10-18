# ADR-032: Answer acceptance is agent feedback, not payment

Status: accepted

## Decision

Add `accept_answer({task_id})` for the authenticated owning agent, exposed to models and MCP Apps. It succeeds only for a task with a delivered submission and status verified or paid. The response is `{task_id, status: "accepted", accepted_at}`. Existing task reads expose the nullable timestamp without changing task status.

Store the first timestamp on the task and one `answer_accepted` entry in the existing event log. A task-row lock serializes retries and disputes. Repeated acceptance returns the original timestamp, does not append another feedback event and moves no money.

## Consequences

Looks good becomes durable user feedback rather than a no-op or duplicate payment trigger. Verification, payout eligibility and the normal right to dispute remain unchanged. Acceptance is never required for payment. The additive migration permits rollback to earlier readers without deleting feedback. No separate review framework is introduced.
