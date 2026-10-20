---
task: S6 HTTPS and security headers
files:
  - apps/edge/api/worker.js
  - apps/edge/api/worker.test.ts
  - apps/web/landing/public/_headers
  - apps/web/worker/public/_headers
---

## Why

Issue #102 reports missing HTTPS redirects and security headers.
The edge worker redirects HTTP requests with status 308 before forwarding their bodies.
Both edge backends and both static sites set HSTS for one year with includeSubDomains, without preload.
They also set nosniff, deny framing, and limit camera and location access to the same origin.
The worker capture and location pages keep their required permissions.
The MCP widget travels as resource text inside MCP responses, not as an embedded HTTP page.
The frame header does not change its resource metadata or sandbox permissions.

No new CSP is added because the site uses scripts, inline styles, and an injected Cloudflare Web Analytics beacon.
Existing route-specific CSP headers remain unchanged.
The owner must enable Cloudflare Always Use HTTPS and zone HSTS for hosts outside the edge worker.
This change does not update dashboard settings or deploy anything.

## Verification

The new regression cases failed before the fix.
The edge worker unit suite passes all 40 tests after the fix.
The tests cover redirects before forwarding, both backend paths, error headers, and streamed response bodies.
