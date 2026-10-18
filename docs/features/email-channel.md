# Email channel

Workers can add one optional email address. Eyes uses it to send task offers, capture links and paid notices, and to sign you in to your setup page at `/me`. A mobile number is still required for every worker.

## How it works

- Every worker needs a mobile number. Each account has one phone. You can't change it yourself; text HELP to ask.
- Each account has at most one email.
- An email entered at join stays pending until your phone texts START.
- After START, Eyes emails a verification link. It works once and expires after 24 hours.
- A pending email that is not confirmed within 24 hours is dropped.
- Email replies YES, STOP and HELP work the same as texts.
- Eyes emails come from `work@glad-marsh.primitive.email`. Reply to that address.
- STOP by text or email deletes your email. Removing your account does too.

## How to try it

1. Join at https://app.eyes.pictures with your mobile number.
2. From your phone, text START.
3. Open your setup page at `/me` and tap Add email in the Email row.
4. Open the confirmation link in the email within 24 hours. It signs you in and opens `/me`, where the Email row now shows your address (masked).
5. Later, sign in at https://app.eyes.pictures/login: enter that email, tap "Email me a sign-in link", and open the link within 15 minutes.

You can also change or remove the email from the Email row on `/me`. Adding or changing it emails a new confirmation link.

## Where in the code

- [`packages/comms/src/primitive.ts`](../../packages/comms/src/primitive.ts): sends and receives email through Primitive.
- [`packages/comms/src/inkbox.ts`](../../packages/comms/src/inkbox.ts): Inkbox sends the first email that Primitive refuses.
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): task offers and worker replies. Email replies use the same path as texts.
- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): the `/status` email line and the `/w/me` route.
- [`apps/web/worker/src/me.ts`](../../apps/web/worker/src/me.ts) and [`apps/web/worker/src/pages/me.astro`](../../apps/web/worker/src/pages/me.astro): the `/me` setup page and its Email row.
- [`apps/web/worker/src/email.ts`](../../apps/web/worker/src/email.ts): the worker page's email calls; [`apps/web/worker/src/pages/login.astro`](../../apps/web/worker/src/pages/login.astro): `/login`, email sign-in and the emailed-link handler.
- [`apps/web/worker/src/pages/privacy.astro`](../../apps/web/worker/src/pages/privacy.astro): what we store and for how long.

## Related

- [iMessage dispatch](imessage-dispatch.md): the text flow that email runs alongside.
