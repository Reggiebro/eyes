# InsForge - vendor note
Fetched: 2026-10-16. Local clone HEAD (read-only cross-check): `fca20f318 2026-09-11` (backend package version 2.3.2). npm `@insforge/sdk` latest = 1.5.2 (published 2026-07-31), `@insforge/cli` latest = 0.2.8.
Sources (all read):
- https://docs.insforge.dev/llms.txt
- https://docs.insforge.dev/quickstart.md
- https://docs.insforge.dev/sdks/typescript/overview.md
- https://docs.insforge.dev/sdks/typescript/database.md
- https://docs.insforge.dev/sdks/typescript/storage.md
- https://docs.insforge.dev/sdks/typescript/functions.md
- https://docs.insforge.dev/sdks/typescript/realtime.md
- https://docs.insforge.dev/sdks/rest/database.md
- https://docs.insforge.dev/sdks/rest/storage.md
- https://docs.insforge.dev/sdks/rest/functions.md
- https://docs.insforge.dev/core-concepts/database/migrations.md
- https://docs.insforge.dev/core-concepts/functions/overview.md and /schedules.md
- https://docs.insforge.dev/core-concepts/sites/overview.md
- https://docs.insforge.dev/core-concepts/realtime/overview.md
- https://docs.insforge.dev/agent-native/cli-harness.md
- https://docs.insforge.dev/mcp-setup.md
- Local clone `/Users/ayaanmacmini3/Documents/InsForge` (`backend/src/api/middlewares/auth.ts`, `functions/`), and `npx @insforge/cli@0.2.8 <cmd> --help` output.

## What Eyes uses it for
- Postgres: tasks, workers, agent balances, ledger, API keys, verifications. Atomic claim and escrow via SQL.
- Storage: worker capture photos (bucket `captures`).
- Edge Functions (Deno): inbound webhooks (Inkbox SMS reply, Stripe), optionally the capture-submit endpoint.
- Schedules (pg_cron): "expire overdue tasks every minute".
- Sites: host worker capture page + demo dashboard over HTTPS.
- Realtime: live dashboard feed via DB trigger -> channel.
- MCP/CLI: the sponsor-prize angle (agent-operable backend).
- Auth: NOT needed (see below).

## Auth & setup
Cloud project: sign up at https://insforge.dev, "Create New Project" (ready in ~3s), copy Project ID from URL `https://insforge.dev/dashboard/project/<id>` (quickstart.md). Or CLI: `npx @insforge/cli create --name eyes --region us-west` (regions: us-east, us-west, eu-central, ap-southeast).

```bash
npx @insforge/cli login
npx @insforge/cli link --project-id <id>      # writes link file in cwd
npx @insforge/cli secrets get ANON_KEY
npx @insforge/cli secrets get API_KEY          # admin key, starts ik_
```
Source: quickstart.md, cli-harness.md. Run the CLI with `npx` (docs say do not install globally). `--json` on any command gives structured output, `--yes` skips prompts.

Project reserved secrets (cli-harness.md): `ANON_KEY` (public, SDK `anonKey`), `API_KEY` (admin `ik_...`, server only), `JWT_SECRET`, `INSFORGE_BASE_URL` (e.g. `https://<app>.<region>.insforge.app`). Keys also in dashboard: click Install, then API Keys.

Env var names for the Eyes monorepo (our choice, mapped from the above):
| Our name | Value | Where |
|---|---|---|
| `INSFORGE_BASE_URL` | project base URL | `secrets get INSFORGE_BASE_URL` or dashboard |
| `INSFORGE_ANON_KEY` | anon key | browser-safe; use as `VITE_INSFORGE_ANON_KEY`/`NEXT_PUBLIC_...` on the SPA |
| `INSFORGE_API_KEY` | admin `ik_` key | server only (MCP server, scripts). Never in browser bundle |

Inside deployed Edge Functions the docs use `Deno.env.get('INSFORGE_BASE_URL')` and `Deno.env.get('ANON_KEY')` (functions.md example). Custom function secrets: `npx @insforge/cli secrets add KEY VALUE [--reserved] [--expires ISO]` ; "available to your function code the same way" (functions/overview.md). Secrets are encrypted at rest; env vars are plain.

No test/live split: one project = one environment. Optional backend branching (`branch create`) exists for rehearsing migrations (agent-native/branching).

SDK client (https://docs.insforge.dev/sdks/typescript/overview.md):
```ts
import { createClient } from '@insforge/sdk';   // pnpm add @insforge/sdk@latest (1.5.2)
const insforge = createClient({ baseUrl: process.env.INSFORGE_BASE_URL!, anonKey: process.env.INSFORGE_ANON_KEY });
```
Server-side privileged access: docs only show the admin key as `Authorization: Bearer <ik_...>` on REST (sdks/rest/*.md; `x-api-key` header also accepted per auth.ts). Whether `createClient({anonKey: API_KEY})` works is UNVERIFIED (see Open questions). Safe path: raw `fetch` with the Bearer header for server code.

## Exact SDK/API calls we need

### Database: SQL migrations
Recommended (migrations.md): files `migrations/<YYYYMMDDHHmmss>_<name>.sql`; each file runs in ONE transaction; `BEGIN/COMMIT/ROLLBACK` inside are rejected; forward-only.
```bash
npx @insforge/cli db migrations new create-eyes-schema
npx @insforge/cli db migrations up --all
npx @insforge/cli db migrations list
npx @insforge/cli db query "select 1"                 # 30s statement_timeout, wrapped in txn
npx @insforge/cli db query --unrestricted "..."       # not txn-wrapped
```
REST equivalent (sdks/rest/database.md), admin only:
`POST /api/database/migrations` body `{version:"20261016000000", name:"create-eyes-schema", sql:"..."}` with `Authorization: Bearer <ik_key>`. Raw SQL: `POST /api/database/advance/rawsql` (strict, blocks system tables and auth.users) and `POST /api/database/advance/rawsql/unrestricted`. MCP tool `run-raw-sql` is the agent path.
PostgREST reloads schema automatically after migrations. Table names: snake_case lowercase; tables are instantly REST-exposed at `/api/database/records/<table>`.

### Database: SDK CRUD (sdks/typescript/database.md)
All return `{ data, error }`. `update/delete` REQUIRE filters. Chain `.select()` after insert/update to get rows back.
```ts
const { data, error } = await insforge.database.from('tasks').insert({ ... }).select();
const { data } = await insforge.database.from('tasks').select('*').eq('status','dispatched').order('created_at',{ascending:false}).limit(20);
```
Filters: eq, neq, gt, gte, lt, lte, like, ilike, in, is. Modifiers: order, limit, range, single, maybeSingle. Upsert exists via REST (needs unique constraint) and MCP `bulk-upsert`.

### Race-safe "first YES wins" (two options)
Option A, SDK filters. The REST PATCH is `PATCH /api/database/records/tasks?id=eq.X&status=eq.dispatched` (PostgREST) = one SQL `UPDATE ... WHERE id=X AND status='dispatched'`, atomic in Postgres. Both losers match zero rows:
```ts
const { data, error } = await insforge.database.from('tasks')
  .update({ status: 'claimed', claimed_by: workerId, claimed_at: new Date().toISOString() })
  .eq('id', taskId).eq('status', 'dispatched')
  .select();
const won = !error && data?.length === 1;   // zero rows => someone else won (or expired)
```
(Pattern from the documented update+filters+select calls in database.md; the atomicity claim is standard PostgREST/Postgres semantics, not an InsForge doc statement.)
Option B, RPC (preferred for escrow; see next). `rpc()` signature (database.md): `insforge.database.rpc(functionName, args?) -> { data, error }`. REST: `POST /api/database/rpc/{functionName}` JSON body = named args.

### Multi-statement atomic ledger writes (escrow)
Write a plpgsql function; one function call = one transaction in Postgres, so all statements commit or roll back together. Call via `rpc`. Use `SECURITY DEFINER`; the Realtime doc itself uses `LANGUAGE plpgsql SECURITY DEFINER` triggers (realtime/overview.md).
```sql
create or replace function public.escrow_task(p_agent uuid, p_task uuid, p_bounty int, p_fee int)
returns boolean language plpgsql security definer as $$
declare n int;
begin
  update agents set balance_cents = balance_cents - (p_bounty + p_fee)
   where id = p_agent and balance_cents >= p_bounty + p_fee;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  insert into ledger(agent_id, task_id, kind, amount_cents) values (p_agent, p_task, 'escrow', -(p_bounty + p_fee));
  return true;
end $$;
```
```ts
const { data: ok, error } = await insforge.database.rpc('escrow_task', { p_agent, p_task, p_bounty: 300, p_fee: 50 });
```
Whether PostgREST exposes the function to the role used (EXECUTE grant to anon/authenticated/admin) is not documented: UNVERIFIED. Add explicit `grant execute ... to <role>` only after confirming roles; calling with the admin API key is the safe default. RPC return shape for scalar/table is shown only as raw JSON in REST docs; test once.

### Row-level security model
Postgres RLS reading the JWT; anon key maps to role `anon`, `auth.uid()` NULL for anon so identity policies fail closed (auth.ts `verifyAnonKey`, clone). Admin API key sets `req.hasApiKey` and is treated as admin on `/records` (clone auth.ts / records routes line ~100). Eyes plan: keep ALL tables server-only (RLS enabled, no anon policies), accessed with the admin key from the MCP server and functions; the browser capture page talks only to a function or uses a narrow storage bucket (below).

### Storage (sdks/typescript/storage.md, sdks/rest/storage.md)
Create bucket: CLI `npx @insforge/cli storage create-bucket captures --public|--private` (default public), REST `POST /api/storage/buckets {bucketName, isPublic}` (admin), MCP `create-bucket`. Names: alphanumeric, `_`, `-`.
Browser upload via SDK:
```ts
const { data, error } = await insforge.storage.from('captures').upload(`tasks/${taskId}/${Date.now()}.jpg`, blob);
// data = { bucket, key, size, mimeType, uploadedAt, url }
```
`uploadAuto(file)` generates a unique key. Uploading to an existing key REPLACES it. `url` is `https://<app>.<region>.insforge.app/api/storage/buckets/captures/objects/<urlencoded key>`; save `key` too. `download(key)` returns Blob; `remove(key)`.
Under the hood (REST): `POST /api/storage/buckets/{b}/upload-strategy {filename, contentType, size}` -> `{method:"presigned"|"direct", uploadUrl, fields, key, confirmRequired, confirmUrl}`; S3 backends: POST multipart to `uploadUrl` with all `fields` plus `file`, then `POST .../objects/{key}/confirm-upload {size, contentType}`; local backend: PUT multipart `file` to `uploadUrl`. Download: `GET /api/storage/buckets/{b}/download-strategy/objects/{key}` -> `{method:"direct"|"presigned", url, expiresAt?}`; public bucket gives direct URL, private gives presigned.
Auth for upload: `Authorization: Bearer <jwt-or-anon-key>`; whether anon can write depends on storage RLS policies (clone migration 036 grants `auth.jwt()` to anon; bucket write policy for anon UNVERIFIED). Safest design: function `capture-submit` receives multipart from the page and writes with the admin key, so the browser needs no storage write rights.
Claude vision: fetch the object server-side with the admin key (or presigned download URL) and pass bytes/URL to Anthropic.

### Edge Functions (functions/overview.md, sdks/rest/functions.md, clone `functions/`)
- Runtime: Deno (cloud runs on Deno Subhosting). ESM imports via `npm:`/`jsr:`/`esm.sh` specifiers, no bundler.
- Code shape: default-export async handler, `Request` in, `Response` out:
```ts
export default async function (req: Request): Promise<Response> {
  const body = await req.text();            // raw body available
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
```
(CommonJS `module.exports = async function (request){}` form also appears in clone examples `functions/examples/demo-hello-world.js`.) Functions get injected `createClient` in the clone demo; the docs example uses `import { createClient } from 'npm:@insforge/sdk'`.
- Deploy: `npx @insforge/cli functions deploy <slug> --file ./fn.ts [--name ..] [--description ..]` (create or update). Others: `functions list|code|invoke|delete`. REST: `POST /api/functions {name, code, slug?, description?, status}`, `PUT /api/functions/{slug}`. Status `draft|active|error`. MCP: `create-function`, `update-function`. Code containing patterns like `Deno.run` is rejected (400).
- Invoke URL: REST doc says `ANY https://<app>.<region>.insforge.app/functions/{slug}` (no `/api` prefix). The overview page says `https://<project>.insforge.dev/functions/<name>` and the schedules page shows `https://myapp.functions.insforge.app/cleanup`. Inconsistent: after first deploy, confirm the real URL from the dashboard. SDK: `insforge.functions.invoke('slug', { body, headers, method })` -> `{data,error}` (default POST; token auto-attached).
- Auth header on invocation: REST doc lists `Authorization: Bearer <jwt-or-anon-key>` for "authenticated" calls; a no-auth curl is shown for hello-world. Whether an external webhook sender with NO Authorization header reaches a function is UNVERIFIED (test with curl early; if blocked, put `?token=` secret in our webhook URL or pass anon key as bearer if the vendor lets us add headers).
- Secrets/env: see Auth section. Errors: 404 not found/not active, 500 runtime error `{error, message}`, 502 proxy failure.
- CORS: handle `OPTIONS` yourself (docs examples return 204 with Access-Control headers).
- Worker timeout in self-host clone: `WORKER_TIMEOUT_MS` default 60000. Cloud limit UNVERIFIED.

### Cron / schedules (functions/schedules.md)
Native, pg_cron-backed. Min interval 1 minute for 5-field cron; the CLI help also accepts pg_cron interval syntax for sub-minute ("30 seconds"). Failed runs are NOT retried, so make jobs idempotent. Each tick = HTTP request to a URL (so the job is an edge function, not raw SQL).
```bash
npx @insforge/cli schedules create --name expire-tasks --cron "* * * * *" \
  --url https://<function-url>/expire-tasks --method POST \
  --headers '{"Authorization":"Bearer ${{secrets.CRON_TOKEN}}"}'
npx @insforge/cli schedules list | logs <id> | delete <id>
```
SQL form: `select schedules.create_job(name => 'expire-tasks', schedule => '* * * * *', url => '...', headers => jsonb_build_object('Authorization','Bearer ${{secrets.CRON_TOKEN}}'));`. `${{secrets.KEY}}` placeholders in headers are resolved and encrypted at creation; deleting a referenced secret breaks the job. Logs in `schedules.job_logs`. Gotcha: backend closes idle keep-alive after 65s; for sparse jobs add `Connection: close` or short client timeouts (every-minute cadence is safe-ish).
Expiry function should do the refund atomically via an RPC (`update tasks set status='expired' where status in ('dispatched','claimed') and deadline < now() returning ...` plus ledger refund in the same plpgsql function).

### Hosting (sites/overview.md)
InsForge Sites uploads source and triggers a VERCEL production build; framework detection from `package.json`/`vercel.json`.
```bash
npx @insforge/cli deployments deploy ./apps/web
npx @insforge/cli deployments env set VITE_INSFORGE_URL https://<app>.<region>.insforge.app
npx @insforge/cli deployments env set VITE_INSFORGE_ANON_KEY <anon>
npx @insforge/cli deployments list | status <id> --sync | cancel <id>
```
URL: `https://<appkey>.insforge.site` (HTTPS via Vercel, so camera `getUserMedia` and `navigator.geolocation` work); optional slug `https://<slug>.insforge.site`; custom domain via dashboard + CNAME. Source upload skips node_modules, .git, build output, .env. Only `VITE_`/`NEXT_PUBLIC_` env are browser-exposed. Server regions default `iad1`.
Pure static output works as "static site" per docs (framework builds incl. static sites). Needs a Vercel-buildable project (set build command/output via `vercel.json`).

### Realtime for the demo dashboard (realtime/overview.md, sdks/typescript/realtime.md)
Socket.IO channels. DB trigger publishes with predefined `realtime.publish(channel, event, payload)`:
```sql
create function public.notify_task() returns trigger language plpgsql security definer as $$
begin perform realtime.publish('tasks', 'task_changed', jsonb_build_object('id', new.id, 'status', new.status)); return new; end $$;
create trigger task_realtime after insert or update of status on public.tasks for each row execute function public.notify_task();
```
Client:
```ts
await insforge.realtime.connect();                       // times out after 10s; uses anon key if no user
const sub = await insforge.realtime.subscribe('tasks');  // { ok, channel, presence } | { ok:false, error }
if (!sub.ok) throw new Error(sub.error.message);
insforge.realtime.on('task_changed', (m) => render(m));  // m.meta.messageId available
```
A channel/pattern must exist in the Realtime dashboard (channels list patterns like `order:%`). Realtime is "open while prototyping", then locked via RLS on `realtime.channels` (SELECT) and `realtime.messages` (INSERT). Clone migration 017 grants anon SELECT on `realtime.channels` and INSERT on `realtime.messages`. Channels can also POST each message to webhook URLs (with event/channel/message-id headers, retry on transient network failure).
Fallback if channel setup fights us: poll `select` every 2s.

### Auth: skip
Eyes uses its own agent API keys and phone-based workers with signed capture links. InsForge Auth (auth.users, email/OAuth/JWT) is optional; the platform works with anon key + admin key alone (anon role + RLS, admin via `API_KEY`). Recommendation: do not use InsForge Auth; keep tables locked, mediate everything through functions/MCP with the admin key.

### MCP server and agent features (sponsor prize) (mcp-setup.md, cli-harness.md)
- Remote MCP: `npx add-mcp https://mcp.insforge.dev/mcp` (browser login, org/project binding). Config e.g. `.cursor/mcp.json`: `{"mcpServers":{"insforge":{"url":"https://mcp.insforge.dev/mcp"}}}`.
- Tools: `get-table-schema`, `run-raw-sql`, `bulk-upsert`, `create-bucket`, `list-buckets`, `delete-bucket`, `create-function`, `get-function`, `update-function`, `delete-function`, `create-deployment`, `start-deployment`, `get-container-logs`, `fetch-docs`, `get-anon-key`, `get-backend-metadata`, `get-function-logs`. Writes need admin API key.
- Agent-native: CLI with `--json`, `diagnose` / `diagnose --ai "..."`, config-as-code (`config plan|apply|export`), backend branching. Pitch angle for Eyes: build the whole backend through the InsForge MCP/CLI by an agent, show the transcript.

## Webhooks / inbound
InsForge has no built-in inbound webhook product beyond edge functions; each function is a public HTTPS endpoint (see URL caveat). Per vendor (Inkbox/Stripe) specs, read the raw body with `await req.text()` before parsing; Deno's `Request` gives this without a body-parser. Stripe signature checking in Deno must use the async verifier (`stripe.webhooks.constructEventAsync`) with `npm:stripe`; UNVERIFIED on InsForge runtime (see the Stripe note). InsForge outbound webhooks (Realtime channel -> URL) retry only transient network failures. Payments product has its own Stripe integration (core-concepts/payments/stripe.md, not read): we are NOT using it; we use our own Stripe code.

## Limits, test-mode quirks, gotchas
- Migration files are transactional: no `CREATE INDEX CONCURRENTLY`/`VACUUM` (use `db query --unrestricted`). `db query` has 30s statement_timeout.
- `update()`/`delete()` without filters is a footgun; always filter.
- Never edit applied migration files; add new ones. Ad hoc dashboard edits cause drift from `system.custom_migrations`.
- Schedules: 1-minute floor for 5-field cron, no retries, idempotent jobs only.
- Storage: same key overwrites; presigned (S3) upload needs the confirm-upload step; `isPublic` defaults to TRUE on bucket creation, so pass `--private` for captures if photos are sensitive (then use presigned download URLs).
- Sites go through Vercel: first build takes a minute; build must succeed from source upload.
- Function invoke path has no `/api` prefix, admin function management does.
- `projects delete` is irreversible; never pass `--yes`.
- Self-hosting is possible (Docker) but not needed.

## Contradictions with our plan
1. Plan: "InsForge hosting" for static SPA. Docs: Sites build and deploy via Vercel from a source upload (needs a framework/static project that builds), URL `*.insforge.site`. (sites/overview.md)
2. Plan: "cron" for expiry as SQL job. Docs: schedules call an HTTP URL (a function), 1-minute floor, no retry. (functions/schedules.md)
3. Plan: "service key". Docs: names are `API_KEY` (admin, `ik_`) and `ANON_KEY`; there is no `service_role` key. (cli-harness.md)
4. Plan: webhooks hosted on functions. Docs: function URLs are documented three different ways; invoke auth requirement for unauthenticated third-party callers is not stated. (sdks/rest/functions.md, functions/overview.md, functions/schedules.md)
5. Plan: "signed upload". Docs: SDK `upload()` goes through the InsForge API with the caller's token; presigned form exists only on S3-backed buckets via upload-strategy. (sdks/rest/storage.md)

## Open questions / unverified
- Can `createClient({ anonKey: <ik_ API key> })` act as admin in SDK calls? Docs only show admin key as REST Bearer. Test or use raw fetch.
- Does PostgREST expose custom plpgsql functions to the anon/admin roles without explicit EXECUTE grants? Test `rpc` once after the first migration.
- Does an unauthenticated third-party POST (no Authorization header) reach an edge function in cloud? Test with curl on first deploy.
- Canonical production function base URL (three forms in docs).
- Cloud execution timeout, memory, request-body size limits for functions; storage object size limits; free-tier quotas and rate limits (pricing.md not read).
- Whether anon can INSERT into storage bucket by default RLS; recommended to avoid by proxying through a function.
- Whether `realtime.publish` requires a pre-created channel row for `tasks` (docs imply channels are created in the dashboard).
- `schedules.create_job` `${{secrets.X}}` availability on the hackathon plan.
- Stripe/Deno compatibility of `npm:stripe` inside the cloud function runtime (Deno Subhosting).
