# Stripe - vendor note

Fetched: 2026-10-16. Sources actually read:
- https://docs.stripe.com/llms.txt
- https://docs.stripe.com/events/set-up-events.md
- https://docs.stripe.com/webhooks/signature (redirects to manage-webhook-endpoints content)
- https://docs.stripe.com/connect/testing
- https://docs.stripe.com/connect/design-an-integration.md
- https://docs.stripe.com/connect/interactive-platform-guide.md
- https://docs.stripe.com/connect/accounts-v2.md
- https://docs.stripe.com/connect/hosted-onboarding.md
- https://docs.stripe.com/connect/separate-charges-and-transfers.md?platform=web&integration=checkout&ui=stripe-hosted
- https://docs.stripe.com/testing.md
- https://docs.stripe.com/sandboxes.md
- https://docs.stripe.com/checkout/quickstart.md
- https://docs.stripe.com/api/v2/core/account-links/create.md
- https://docs.stripe.com/agents.md
- https://docs.stripe.com/mcp.md
- https://docs.stripe.com/payments/machine.md
- npm registry via `npm view stripe` (2026-10-16)

## What Eyes uses it for
1. Top-ups: agent pays by Stripe-hosted Checkout (mode=payment). On success webhook we credit the internal cents ledger.
2. Payouts: workers onboard as Connect connected accounts; on verified capture we move the bounty with a platform-to-connected-account Transfer (separate charges and transfers pattern: the charge sits on the platform, the transfer is decoupled).
3. Escrow is NOT a Stripe object. It is our internal ledger. Stripe only sees: Checkout charge (top-up), Transfer (payout to worker), and Payout (worker's connected account to bank).

## Auth & setup

Package: `stripe@23.0.0` (npm `latest` on 2026-10-16; the Checkout quickstart sample pins `"stripe": "^23.0.0"`). Source: npm view, https://docs.stripe.com/checkout/quickstart.md.
Install: `pnpm add stripe`. Stripe CLI: `npm install -g @stripe/cli@latest` then `stripe login` (CLI key valid 90 days). Source: https://docs.stripe.com/events/set-up-events.md

Env vars we should use:
| Name | Purpose | Where from |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | server API key | Dashboard > Developers > API keys (sandbox) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` verifying `Stripe-Signature` | Dashboard endpoint "Reveal secret", or printed by `stripe listen` (they DIFFER, do not mix) |
| `STRIPE_PUBLISHABLE_KEY` | only if client-side Stripe.js is used; hosted Checkout does not need it | same API keys page |
| `APP_BASE_URL` | build success/cancel/return/refresh URLs | ours |

The `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` naming matches Stripe's own sample env file. Source: https://docs.stripe.com/checkout/quickstart.md

Test vs live: Stripe says "for new integrations, use general sandboxes instead of your test mode sandbox"; use separate sandboxes for local dev and CI. Source: https://docs.stripe.com/sandboxes.md. Sandbox limitation relevant to us: "You can't create connections between a Connect platform's sandbox and connected account sandboxes" (Connect works inside one sandbox; connected accounts are created in that sandbox via API, which is what we do).
Coding agents/automation can run `stripe sandbox create --help` to provision an anonymous sandbox with working API keys, no registration. Source: same page. (Handy for a CI sandbox; for the demo prefer the team's real dashboard sandbox so the judge can see it.)
Connect must be enabled on the platform ("onboard your platform to Connect" at dashboard.stripe.com/settings/connect/platform-profile) and onboarding branding set (hosted onboarding "requires" brand name, color, icon in Connect settings). Sources: design-an-integration.md, hosted-onboarding.md.

Restricted keys: events page says to use a restricted key for production handlers (https://docs.stripe.com/events/set-up-events.md). For a hackathon use the sandbox secret key.

## Exact SDK/API calls we need

Client init (stripe-node v23):
```ts
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
```
Source: https://docs.stripe.com/checkout/quickstart.md (`new Stripe(process.env.STRIPE_SECRET_KEY)`).

### 1. Checkout Session for top-up
Adapted from https://docs.stripe.com/checkout/quickstart.md and the separate-charges page (inline `price_data`, `mode=payment`, `{CHECKOUT_SESSION_ID}` in success_url):
```ts
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{
    price_data: {
      currency: 'usd',
      product_data: { name: 'Eyes balance top-up' },
      unit_amount: amountCents,
    },
    quantity: 1,
  }],
  client_reference_id: agentId,
  metadata: { agent_id: agentId, topup_cents: String(amountCents) },
  payment_intent_data: { metadata: { agent_id: agentId }, transfer_group: `topup_${agentId}` },
  success_url: `${APP_BASE_URL}/topup/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${APP_BASE_URL}/topup/cancel`,
}, { idempotencyKey: `topup-${topupRowId}` });
// redirect/return session.url
```
Notes: `payment_intent_data.transfer_group` is documented (separate-charges page). `metadata`, `client_reference_id`, `cancel_url`, `payment_intent_data.metadata` and the `idempotencyKey` request option are standard but were NOT shown on the pages I fetched; see Open questions. "As soon as they're sent to the Checkout page, the order is final", so create a new Session per top-up. Source: quickstart.

### 2. Make test top-ups land in AVAILABLE balance (critical for transfers)
Test cards normally settle to pending balance. "To send the funds from a test transaction directly to your available balance, use the test cards in this section." Source: https://docs.stripe.com/testing.md
- `4000000000000077`: US charge succeeds, funds go straight to available balance. PaymentMethod `pm_card_bypassPending`, token `tok_bypassPending`.
- `4000003720000278`: international equivalent.
- Any future expiry, any CVC, any postal code works.
Plain `4242424242424242` succeeds but funds stay pending, so a later Transfer can fail for insufficient available balance.

### 3. Connected account for workers (see Contradictions: Accounts v2 vs v1)
Hosted onboarding doc still shows creating a v1 Account with `controller` properties, no `type`:
```ts
const account = await stripe.accounts.create({
  controller: {
    fees: { payer: 'application' },
    losses: { payments: 'application' },
    stripe_dashboard: { type: 'express' },
  },
  // capabilities: { transfers: { requested: true } }  // see Open questions
});
```
Source: curl form at https://docs.stripe.com/connect/hosted-onboarding.md (`controller[fees][payer]=application`, `controller[losses][payments]=application`, `controller[stripe_dashboard][type]=express`). The snake_case-to-JS mapping above is mine. `stripe_dashboard.type` is immutable once set.
Prefill what we know (email, business_profile.url or product_description) at create time, before generating the link; after the link is created you can't read/write the account's info. Source: same page.

### 4. Account Link (hosted onboarding), v1
```ts
const link = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: `${APP_BASE_URL}/worker/onboard/refresh`,
  return_url: `${APP_BASE_URL}/worker/onboard/return`,
  type: 'account_onboarding',
  collection_options: { fields: 'currently_due' }, // 'eventually_due' = up-front
});
// send worker to link.url
```
Source: curl in https://docs.stripe.com/connect/hosted-onboarding.md. Rules from that page: each URL is single use; expires in "a few minutes"; refresh_url must mint a fresh link with same params; `return_url` fires on finish OR "Save for later" and carries no state, so retrieve the account and check `requirements`; HTTP URLs are fine in test, HTTPS-only in live; link URLs must not be emailed/texted outside the platform app ("Don't email, text, or otherwise send account link URLs outside of your platform application"). NOTE: our flow texts workers via SMS. Do not SMS the raw Stripe link; SMS a link to OUR page, which authenticates the worker and then mints the Account Link on click.
Use `currently_due` for fastest hackathon onboarding (incremental).

Accounts v2 alternative link call (only if we choose v2): `POST /v2/core/account_links` with header `Stripe-Version: 2026-09-30.endive`, body `{account, use_case:{type:'account_onboarding', account_onboarding:{return_url, refresh_url}}}`, response has `url`, `expires_at` (about 10 min in sample). Errors: `accounts_v2_access_blocked` if v2 not enabled for the merchant. Source: https://docs.stripe.com/api/v2/core/account-links/create.md

### 5. Check readiness
Retrieve the account and check `charges_enabled`/`payouts_enabled`/`requirements`. The doc says on return, "Retrieve the account and check the requirements hash for outstanding requirements", or cache state from `account.updated`. Source: hosted-onboarding.md. For a transfer-only worker the relevant gate is the `transfers` capability being active plus a verified external account (payouts "blocked if your connected account doesn't have a verified external account", design-an-integration.md). Our readiness check: `account.capabilities.transfers === 'active'` (field shape unverified, see Open questions) and `payouts_enabled === true`.

### 6. Transfer to worker
```ts
const transfer = await stripe.transfers.create({
  amount: bountyCents,            // integer cents
  currency: 'usd',
  destination: workerAcctId,      // acct_...
  transfer_group: `task_${taskId}`,
  metadata: { task_id: taskId },
}, { idempotencyKey: `payout-${taskId}-${workerId}` });
```
Source for `amount/currency/destination/transfer_group`: curl at the separate-charges page. Facts: transfer fails if amount exceeds platform AVAILABLE balance and Stripe "doesn't automatically retry failed transfer requests"; after adding funds you must repeat failed transfers. `transfer_group` is only a label ("doesn't affect any standard functionality"). A transfer needs neither a charge nor a group. `source_transaction` (a charge id, from PaymentIntent `latest_charge`) makes the transfer succeed immediately and defers actual availability; cannot be changed later; amount can't exceed the source charge; currency must match. We should NOT use `source_transaction` because our balance is a pooled ledger, not per-charge. We rely on `4000000000000077` for the funds.
Same-region requirement: platform and connected account must be in the same region (US-US for us) unless cross-border rules apply. Source: same page.

### 7. Payout to worker's bank
Automatic: "By default, Stripe pays out funds that have settled in your connected accounts' balances on a daily rolling basis." Source: design-an-integration.md. Test bank for payouts: routing `110000000`, account `000123456789`. Source: connect/testing.

## Webhooks / inbound

Event we credit on: `checkout.session.completed` ("customer has successfully authorized the payment"). For async payment methods also handle `checkout.session.async_payment_succeeded` / `_failed`; cards complete synchronously. Stripe recommends listening to events, not trusting the success redirect. Source: separate-charges page. Always re-check `session.payment_status === 'paid'` before crediting (my guidance, standard field, unverified on fetched pages).
Also subscribe: `account.updated` (worker onboarding/requirements changes; "Listen to the account.updated event", hosted-onboarding.md). Optional: `charge.succeeded`.

Verification (snapshot events, what we use) verbatim pattern from https://docs.stripe.com/events/set-up-events.md:
```ts
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }
  // switch (event.type) ...
  res.json({ received: true });
});
```
- Header: `Stripe-Signature`, format `t=xxx,v1=yyy,v0=zzz` (manage-webhook-endpoints content at /webhooks/signature).
- Body must be the exact raw bytes/UTF-8 string. In Express put the webhook route BEFORE `express.json()`. For Next.js App Router see stripe-node example `examples/webhook-signing/nextjs/app/api/webhooks/route.ts` (linked from the same page). For edge/serverless runtimes (InsForge functions likely Deno-style), use the async variant `constructEventAsync` (not shown on fetched pages, see Open questions) with `await req.text()` as the body.
- Docs now push "thin events" with `parseEventNotification`; set-up-events says "Use snapshot events only if a third-party tool requires the full Event object". Snapshot `constructEvent` is still fully supported and documented as the "exception" path; for a 24h hackathon, snapshot `checkout.session.completed` is simpler. Thin-event handlers need stripe-node >= 22.6.0 GA (event notification table).
- Retries: Stripe retries undelivered events automatically for up to three days; respond 2xx quickly; dedupe by `event.id` (and for double events, `data.object.id` + `type`); 302/3xx counts as failure; HTTPS TLS 1.2+ required in live. Source: manage-webhook-endpoints content.
- Local dev: `stripe listen --forward-to http://localhost:4242/webhook` prints the `whsec_` secret to use locally; `stripe trigger payment_intent.succeeded` for a mock event. `stripe listen --print-secret` prints just the secret (quickstart sample). Sources: set-up-events.md, checkout/quickstart.md.
- Deployed: Dashboard Workbench > Webhooks > Add destination > Webhook endpoint, choose event types, copy secret. Source: set-up-events.md.

## Limits, test-mode quirks, gotchas
- Checkout creates a guest customer unless you pass `customer`/`customer_creation`; fine for us. Source: checkout/quickstart.md.
- Pending vs available: only `4000000000000077` / `pm_card_bypassPending` skips pending (testing.md). Before the demo, run one such top-up so platform available balance covers payouts. Check with `stripe.balance.retrieve()` (the API exists per MCP supported-methods list, https://docs.stripe.com/mcp.md).
- Connect test data (https://docs.stripe.com/connect/testing): SMS code `000-000`; phone `0000000000`; DOB `1901-01-01` (match; `1902-01-01` immediate); SSN `000000000` (last4 `0000`; `222222222` immediate match; `111111111` mismatch); address line1 `address_full_match` with real city/state/postal; bank routing `110000000` acct `000123456789`. Verification can be slow; use the "immediate" variants (`1902-01-01`, `222222222`) to avoid waiting.
- Skip onboarding form: Connect testing page says the test `client_id` can "Force-skip the account form" but only for "Stripe Dashboard accounts only" via OAuth; not applicable to our Express flow. The practical speed-up is the test values above, plus pre-creating 1-2 fully-onboarded demo worker accounts before the demo.
- Account Link URLs die fast and on link-preview unfurl; mint on click.
- Express/test accounts cannot be moved between dashboard types; recreate if wrong.
- Money: all Stripe amounts are integer minor units (cents) for USD; matches our ledger.
- Fee note: our $0.50 fee is ours, not Stripe's. Stripe processing fees are debited from the platform on separate charges and transfers ("Your account balance is debited for the cost of the Stripe fees, refunds, and chargebacks"). So real margin on $3.50 top-ups is less than $0.50; irrelevant in test mode.
- Refund on expiry is an internal ledger credit, not a Stripe refund; refunding a charge does not touch transfers (separate-charges page). Never refund Stripe charges for expired tasks.
- Transfer reversal exists (`POST /v1/transfers/{id}/reversals`) if a payout must be clawed back.

## What a judge sees in the Stripe dashboard
(Derived from the flow above; Stripe dashboard UI itself was not fetched.)
- Payments: the Checkout charge for each top-up (with our `agent_id` metadata, searchable).
- Connect > Connected accounts: each worker acct with onboarding status.
- Transfers (or Balances/Activity): one Transfer per verified task, labelled with `transfer_group=task_<id>` and metadata `task_id`. This is the "worker got paid" moment.
- Connected account balance and Payouts (Connect > account > Payouts) show the bank payout later; in test mode payouts to `000123456789` succeed.
- Nothing escrow-like appears: escrow is our ledger. For the demo narrate it as "Eyes holds the agent's prepaid balance; Stripe sees funds in, funds out." Use `transfer_group` and `metadata` to make the Stripe-side trail legible.

## Agent-related Stripe features (Stripe sponsor track ideas)
- Stripe MCP server `https://mcp.stripe.com` (OAuth, or an "agent API key" as bearer; from Nov 30, 2026 MCP stops accepting full-access or non-Agent-tagged restricted keys). Human confirmation is required for refunds/outbound payments. Connected-account calls via `Stripe-Account` header. Source: https://docs.stripe.com/mcp.md
- `stripe agent setup` installs plugin + MCP + skills; skills index https://docs.stripe.com/.well-known/skills/index.json; any docs page as Markdown by appending `.md`. Source: https://docs.stripe.com/agents.md
- Machine payments (MPP, x402): agents pay per call; card via Shared Payment Tokens (min $0.50) and stablecoins (USDC on Tempo/Solana/Base); works with Connect; Stripe Directory lists agent-payable services (submit via machine-payments@stripe.com, needs llms.txt link). Source: https://docs.stripe.com/payments/machine.md . Possible pitch: Eyes as an agent-payable service in the Directory; do NOT attempt to integrate MPP in the hackathon window unless time is spare (we use prepaid balance).
- Agentic commerce overview: https://docs.stripe.com/agentic-commerce.md (listed, not read). `@stripe/agent-toolkit` is on npm at 0.9.0 (npm view) but I did not read its docs.

## Contradictions with our plan
1. Plan: "Connect Express" via `type: 'express'`. Docs: for NEW Connect platforms use Accounts v2 (`POST /v2/core/accounts`, `configuration.recipient`, `stripe_balance.stripe_transfers`); Accounts v1 is described as for "existing Connect platforms". Hosted-onboarding page still creates v1 accounts with `controller` properties (not `type`), and says v2 IDs can be passed to v1 endpoints. v2 access can be blocked (`accounts_v2_access_blocked`). Recommendation: try v1 `controller` (express dashboard, platform pays fees and bears losses) first because it matches our Transfer model and has documented hosted-onboarding code; fall back to v2 only if the sandbox rejects v1. https://docs.stripe.com/connect/accounts-v2.md, https://docs.stripe.com/connect/hosted-onboarding.md
2. Plan: texting workers an onboarding link. Docs: never send Account Link URLs outside the platform app; links are single-use and expire in minutes (link previews burn them). Send our own URL and mint the link on click. hosted-onboarding.md
3. Plan: "transfers fail unless funds available; use 4000000000000077". Confirmed, but only for balance; also transfers are not retried automatically, so our payout job must retry itself. separate-charges page, testing.md
4. Plan: "test mode". Docs: new integrations should use general sandboxes (keys come from the sandbox); Connect works within a sandbox but platform-sandbox to connected-account-sandbox links are not possible. sandboxes.md
5. Plan: Express Dashboard + Stripe bearing losses is public preview needing `2026-09-30.preview` API version; our setup (platform bears losses) avoids this. design-an-integration.md
6. Plan: `constructEvent` implied. Docs headline thin events + `parseEventNotification`; snapshot path is the "exception" but supported. set-up-events.md

## Open questions / unverified (not confirmed from a fetched primary source)
- `stripe.checkout.sessions.create` params `metadata`, `client_reference_id`, `cancel_url`, `payment_intent_data.metadata` and request option `{ idempotencyKey }` are standard Stripe API but I did not read the API reference or idempotency page. Verify at https://docs.stripe.com/api/checkout/sessions/create and https://docs.stripe.com/api/idempotent_requests.
- Exact v1 capability request for transfer-only workers (`capabilities: { transfers: { requested: true } }`) and the account field `capabilities.transfers === 'active'`; also whether the recipient service agreement (`tos_acceptance.service_agreement: 'recipient'`) is needed or even allowed with `controller` creation (v2 page says recipient service agreement requires v1). Check https://docs.stripe.com/connect/account-capabilities and https://docs.stripe.com/connect/service-agreement-types.
- `type: 'express'` still accepted by `accounts.create` in 2026: not confirmed; docs examples use `controller`.
- `constructEventAsync` signature and use with `Stripe.createSubtleCryptoProvider()` on edge runtimes: not on fetched pages.
- Default signature timestamp tolerance (commonly 300s) not confirmed from fetched pages.
- Key prefixes: `sk_test_`, `pk_test_`, `rk_test_`, `whsec_` (whsec_ confirmed on the events page; the others are from memory) and exact prefixes for general sandbox keys not shown. Agent API keys exist (https://docs.stripe.com/keys.md#agent-keys, not read).
- Dashboard UI paths/labels in the judge-view section are my description, not fetched.
- Whether stripe-node v23 changed method namespaces (docs samples show `client.v1.checkout.sessions.create` for Ruby/Python/PHP/Go; the Node sample uses `stripe.checkout.sessions.create`). Confirm `stripe.checkout.sessions.create`, `stripe.accountLinks.create`, `stripe.transfers.create` compile on 23.0.0 before building.
- Agentic commerce, Shared Payment Tokens, `@stripe/agent-toolkit` internals not read.
