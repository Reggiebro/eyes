# ADR-004: Vendor documentation overrides the build prompt

Status: accepted (G0, 2026-10-16). Sources are the vendor notes in docs/vendor/.

| Prompt assumed | Docs say | Decision |
|---|---|---|
| Eyes can text any nearby worker | Inkbox: US recipients must text START first, else 403 `recipient_not_opted_in` (inkbox.md) | JOIN page tells workers to text START. `workers.opted_in` gates dispatch. |
| Offer text can include the capture link | Inkbox iMessage: before the recipient replies, messages must be 159 chars or fewer with no links (inkbox.md) | Offer has no link; the capture link is sent only after the worker replies YES. |
| Number works right after provisioning | Inkbox: about 10 to 15 minutes of `sender_sms_pending` while 10DLC attaches (inkbox.md) | Provision the number at least an hour before any live test. |
| Text workers a Stripe onboarding link | Stripe: Account Links are single-use and expire in minutes; never text them (stripe.md) | Text our own `/w/connect/:token` URL; it mints the Account Link on click. |
| Test transfers just work | Stripe: transfers fail without available balance; only card 4000000000000077 makes funds available at once (stripe.md) | Pre-fund the platform with that card before every demo. |
| We claim `eyes.primitive.email` and create `tasks@` | Primitive: subdomain is auto-assigned; any local-part works; routing is per domain (primitive.md) | Use the assigned subdomain, `tasks@` plus plus-tags (`agent+<id>@`). |
| Email any agent address | Primitive: new orgs may only send to an allowlist until `send_to_any_domain` is enabled (primitive.md) | Ask Primitive staff to enable it; demo with allowlisted addresses until then. |
| Webhooks, REST and docs served from the Manufact URL | Manufact: whether the gateway forwards non-`/mcp` paths is undocumented (mcp-use-manufact.md) | Test on first deploy. Fallback: same Hono app on another host or InsForge functions. |
| Armature analytics drops into mcp-use | Armature: SDK supports the official MCP SDK, Mastra, fastmcp and mcp-handler, not mcp-use (armature.md) | T3.4 starts by testing the dispatch API from mcp-use middleware; ask the sponsor. |
| Static `/llms.txt` from `public/` | mcp-use: `public/` is served only under `/mcp/_mcp-use/public/` (mcp-use-manufact.md) | Serve docs via explicit routes. |
