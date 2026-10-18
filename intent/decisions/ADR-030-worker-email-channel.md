# ADR-030: Workers add email by emailing us first; email is a second sign-in channel

Status: accepted (2026-10-18), decided by the operator. Changes the frozen contract in `packages/core`: adds `WorkerEmail`; `JoinWorkerInput` takes an optional `email` and refuses a 0,0 location; `WorkerSetup` gains `email_masked` and `email_status`; `Agent` gains `email` and `email_verified_at`; `OutboundEmail` gains `reply_to`; `Payments.createWorkerAccount` takes `email`; adds error `email_taken` (409); `handleWorkerReply` accepts an `email` as well as a `phone`; `EyesService` gains `workerSetEmail`, `workerEmailStart`, `workerConnectEmail`, `workerEmailLogin` and `workerLoginCode`.

## Context
A worker reached Eyes by text only: `JoinWorkerInput` required a phone and nothing else. This adds email as a second channel for two things: attaching an address to the worker's account, and signing in to the setup page (`/me`, ADR-028) by email link.

## Decision
- A worker adds email by emailing first. Texting `EMAIL` (or an address) gets a one-time `mailto:` short link to the work mailbox. `workerEmailStart` returns that mailto and needs the phone to have texted START first, otherwise `invalid_input`. `POST /w/me/email/start` returns it; the "Add email" button on `/me` opens it (T6.53).
- The coded email connects the sender. An authenticated (DMARC-passing) email carrying the connect code sets the sender's address as the worker's email, verified (`workerConnectEmail`). The reply comes back in the same thread through Primitive, via `OutboundEmail.reply_to`.
- A typed address is pending until verified. `workerSetEmail` stores it as pending and emails a link. `EMAIL OFF` (or `null`) removes it.
- Sign-in by email. `workerEmailLogin` emails a 15-minute link to a verified address of an opted-in worker and does nothing otherwise. `workerLoginCode` trades that one-time code for the setup-page token. `POST /w/login/email` always answers 200.
- Email routes are rate-limited and uncached (T6.48).
- An address already used by another account is refused with `email_taken` (409).
- The client never receives the full address. `WorkerSetup.email_masked` shows only the first letter and the domain, for example `j…@example.com`.
- `JoinWorkerInput` validates the address with `WorkerEmail` (`z.email()`, max 254, lowercased).

## Consequences
- Login answers the same whether or not the address exists. Changes to `workerEmailLogin` or `/w/login/email` must keep that. `email_taken` is the one place an address's existence is revealed, and it is only shown on add.
- A worker cannot take another account's address. The error tells them to use a different address or text HELP.
- Any `Payments` adapter must accept `email: string | null` in `createWorkerAccount`.
- Consumers of `Agent` get two new nullable fields.
