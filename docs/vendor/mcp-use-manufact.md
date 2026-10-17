# Manufact (mcp-use SDK + Manufact Cloud) - vendor note

Fetched: 2026-10-16. Sources read:
- https://manufact.com/llms.txt (mcp-use.com/llms.txt 301s here)
- https://docs.manufact.com/llms.txt
- https://docs.manufact.com/cli/deploy
- https://docs.manufact.com/dashboard/quickstart
- https://docs.manufact.com/dashboard/build-runtimes
- https://docs.manufact.com/dashboard/environment-variables
- https://docs.manufact.com/dashboard/connect-clients
- https://docs.manufact.com/dashboard/logs
- https://docs.manufact.com/dashboard/observability
- https://code.claude.com/docs/en/mcp (Claude Code remote MCP + timeouts)
- Local mcp-use monorepo docs (HEAD 8f84452b, 2026-09-20): `/Users/ayaanmacmini3/Documents/mcp-use/docs/v2/typescript/{server/index,server/tools,server/middleware,server/notifications,server/authentication/index,server/deployment/mcp-use,getting-started/quickstart,api-reference/cli-reference,client/tools}.mdx`
- npm package `mcp-use@2.10.0` (installed in scratchpad; read `dist/*.d.ts`) and **executed a local test server** against it (marked VERIFIED-LOCAL below).

## What Eyes uses it for
- The MCP server agents connect to (tools: create request, await_answer, get status, balance, etc.), hosted on Manufact Cloud.
- Prize angle: Manufact cloud dashboard has Usage and traffic, Sessions, Gateway Requests, Alerts, Runtime logs, OTLP sink, Public Chat, Testing pages (page list: https://docs.manufact.com/llms.txt). Show these in the demo.

## Auth & setup
- Package: `mcp-use@2.10.0` (npm `latest`; `npm view mcp-use version` = 2.10.0). Requires Node `>=22.22.2` (package `engines`). Peer-ish deps are bundled (hono, jose, @modelcontextprotocol/server). Install `zod` yourself. The CLI (`mcp-use` binary, `@mcp-use/cli` 4.4.0) ships inside `mcp-use`.
- **WARNING:** npm dist-tag `v1-legacy` = 1.34.8 is a different API (session based). Docs in `docs/typescript/` (not `docs/v2/`) in the local clone describe v1. Pin `"mcp-use": "2.10.0"` and use only v2 patterns below.
- Env vars we define:
  - `EYES_API_KEYS` or DB lookup: our own bearer keys for agents (our code, see Auth below).
  - `MCP_USE_API_KEY`: Manufact CLI non-interactive login (`mcp-use login --api-key "$MCP_USE_API_KEY" --org <org>`). Get it from Manufact dashboard, API keys page (https://docs.manufact.com/dashboard/api-keys, not fetched; location per manufact.com/llms.txt).
  - `PORT`, `HOST`: read by `mcp-use dev/start` (precedence: CLI flag, then env, then server config, then default 3000 / `127.0.0.1`). Source: cli-reference.mdx.
  - `MCP_URL`: public server origin. Manufact injects it at deploy time (https://docs.manufact.com/dashboard/environment-variables). Locally `mcp-use dev` sets it.
  - All vendor secrets (STRIPE_*, INKBOX_*, INSFORGE_*, etc.) are set as Manufact env vars (see Deployment).
- Login: `npx mcp-use login` (browser device flow) then `npx mcp-use whoami`. Creds in `~/.mcp-use/config.json`. Org: `--org <slug>` (cli-reference.mdx).

## Exact SDK/API calls we need

### 1. Server + tool with input/output schema, annotations, errors
Source: server/index.mdx, server/tools.mdx; behavior VERIFIED-LOCAL on mcp-use@2.10.0.
```ts
import { MCPServer } from "mcp-use";
import { z } from "zod";

const server = new MCPServer({
  name: "eyes",
  version: "0.1.0",
  description: "Pay a nearby human to check something in the physical world",
  instructions: "…usage instructions surfaced to the model…",
  // basePath: "/mcp" (default), port: 3000 (default), host: "127.0.0.1" (default)
  // legacy: "stateless" (default)
});

export const requestCheck = server.tool(
  {
    name: "request_check",
    description: "…",
    inputSchema: z.object({ question: z.string().describe("…") }),
    outputSchema: z.object({ request_id: z.string(), status: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (input, ctx) => {
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data, // MUST match outputSchema on success
    };
  },
);

export default server; // CLI (dev/build/start/deploy) needs the default export
```
- Handler returns raw MCP `CallToolResult`. Expected failure: `{ isError: true, content: [{ type: "text", text: JSON.stringify({ code: "INSUFFICIENT_BALANCE", … }) }] }` (an error result may omit `structuredContent`). VERIFIED-LOCAL: client receives `isError: true` with that text.
- Zod validation failure is returned automatically as `isError: true` with text `Input validation error: Invalid arguments for tool ask: q: Invalid input: expected string, received number` (VERIFIED-LOCAL). Not thrown.
- Standard Schema: zod, ArkType, Valibot accepted (server/index.mdx). Use `.describe()` on every field; it flows to the JSON Schema the model sees.
- Tools: `server.tool(def, cb)`. Register all tools at construction time, before the server serves requests.
- `ToolRef` returned by `server.tool` has no direct "invoke handler" method; for unit tests keep business logic in plain functions and have the tool callback call them (see Local dev).

### 2. HTTP, custom routes, raw body, static files
Source: server/middleware.mdx ("Use Hono middleware and routes"), `dist/server.d.ts`. Underlying framework is **Hono**. `server.app` is the `Hono` instance; `server.get/post/put/patch/delete/all/use` are bound helpers.
- MCP endpoint: `POST /mcp` (config `basePath`, default `/mcp`). Port: `PORT` env / `--port` / config `port`, default 3000.
- VERIFIED-LOCAL on 2.10.0:
```ts
server.get("/llms.txt", (c) => c.text(LLMS_TXT));
server.get("/openapi.json", (c) => c.json(openapiDoc));
server.get("/.well-known/agent-card.json", (c) => c.json(card));
server.get("/v1/ping", (c) => c.json({ pong: 1 }));            // REST mirror: server.get/post("/v1/*")
server.app.post("/webhooks/stripe", async (c) => {
  const raw = await c.req.text();                                // RAW body, byte-exact (16-byte body with odd spacing came back len 16)
  const sig = c.req.header("stripe-signature");
  // verify HMAC over `raw`, then JSON.parse(raw)
  return c.json({ received: true });
});
```
- Raw body is not pre-consumed on custom routes. Use `await c.req.text()` or `await c.req.arrayBuffer()` BEFORE any `c.req.json()`.
- `public/` dir is served only under `${basePath}/_mcp-use/public/…` (config.d.ts), so serve `/llms.txt` etc. via custom routes, not `public/`.
- Hono middleware: `server.use("*", async (c, next) => { … await next(); })` or scoped `server.use("/mcp", mw)`.
- CORS off unless `cors: { origin: … }` is set in `new MCPServer`. Host-header protection: defaults to `127.0.0.1` bind with DNS-rebinding protection; set `host: "0.0.0.0"` or run `mcp-use start --host 0.0.0.0` / `HOST=0.0.0.0` for public serving (config.d.ts, cli-reference.mdx). Behind Manufact the platform handles this; set `allowedHosts` only if you see 403/400 on the deployed domain.

### 3. Auth: bearer API key (our own) and reading it in a tool
mcp-use's built-in auth is OAuth-only (Auth0, Clerk, WorkOS, Supabase, Keycloak, Better Auth, Scalekit, Convex, custom DCR provider; server/authentication/index.mdx). There is **no built-in static API key option**. Use Hono middleware on the MCP path. VERIFIED-LOCAL:
```ts
server.use("/mcp", async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const key = h.startsWith("Bearer ") ? h.slice(7) : "";
  const agent = await lookupAgentByKey(key);          // our DB
  if (!agent) return c.json({ error: "unauthorized" }, 401);
  c.set("agentId", agent.id);
  await next();
});
// inside any tool:
async (input, ctx) => {
  const agentId = ctx.get("agentId");                 // values set by c.set() are readable via ctx.get()
  const auth = ctx.request?.header("authorization");  // raw header also available
}
```
- Client without the header gets HTTP 401 `{"error":"unauthorized"}` (VERIFIED-LOCAL). Per-request context, no sessions (server is stateless).
- Do not set `oauth:` on `MCPServer` unless we want OAuth; with it, `ctx.auth` is populated and all MCP requests require a verified token.
- Apply the same middleware to `/v1/*`; do NOT apply it to `/webhooks/*`, `/llms.txt`, `/openapi.json`, `/.well-known/*`.
- Client metadata (`ctx.client.info()`) is self-reported; never use for authz.

### 4. Long-running tool (`await_answer`, up to 120s)
Sources: server/notifications.mdx, client/tools.mdx, code.claude.com/docs/en/mcp.
```ts
async ({ request_id, wait_seconds }, ctx) => {
  const deadline = Date.now() + wait_seconds * 1000;
  while (Date.now() < deadline && !ctx.signal.aborted) {
    const row = await getRequest(request_id);
    if (row.status !== "open") return result(row);
    await ctx.reportProgress(Date.now() - start, wait_seconds * 1000, "waiting for worker");
    await sleep(3000);
  }
  return result(await getRequest(request_id)); // still pending: return status, caller can re-call
}
```
- `ctx.reportProgress(progress, total?, message?)` returns `false` and sends nothing if the caller did not supply a progress token. It must be awaited before the callback returns; there is no background push after the response (notifications.mdx). VERIFIED-LOCAL: with `onprogress` set, client received `{progress:1,total:10,message:'waiting'}`.
- `ctx.signal` is an AbortSignal for client cancellation.
- Client timeouts differ per client. TS MCP SDK/mcp-use client: pass `{ timeout, resetTimeoutOnProgress: true, maxTotalTimeout }` (client/tools.mdx). Claude Code: tool timeout default ~28 h (`MCP_TOOL_TIMEOUT`), idle timeout `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` default 5 min for HTTP, per-server `timeout` in ms is a hard wall clock and progress does not extend it (code.claude.com/docs/en/mcp).
- Recommendation: keep each `await_answer` call to <=60s (or shorter) and let the agent loop, returning `{status:"pending", retry_after_s}`. Unknown: Manufact gateway request timeout (not documented, see Open questions). The 120s design is safer split into two calls.

## Webhooks / inbound
Manufact itself has webhooks only for GitHub push auto-deploys (https://docs.manufact.com/dashboard/integrations, not fetched). For Stripe/Inkbox/Primitive inbound webhooks, use Hono custom routes above (raw body works, VERIFIED-LOCAL). Signature algorithms are in each vendor's own note. BIG RISK: whether the Manufact gateway forwards non-`/mcp` paths on `https://<slug>.run.mcp-use.com` is NOT documented (Open questions). Test this first after the first deploy: `curl https://<slug>.run.mcp-use.com/v1/ping`. If it 404s, host `/v1/*`, webhooks and static files on InsForge functions and keep Manufact for `/mcp` only.

## Deployment (Manufact Cloud)
Manufact = hosted cloud for mcp-use servers (https://manufact.com/llms.txt). Public URL: `https://<your-slug>.run.mcp-use.com/mcp`; slug customizable and custom domains available in Domains tab (https://docs.manufact.com/dashboard/quickstart, /dashboard/connect-clients). Do not guess the hostname; copy it from the dashboard.
- Commands (cli-reference.mdx, docs.manufact.com/cli/deploy):
```bash
npx mcp-use login                     # or: login --api-key "$MCP_USE_API_KEY" --org <org>
npx mcp-use deploy --name eyes                         # GitHub path (default): needs git origin on GitHub + Manufact GitHub App installed
npx mcp-use deploy --no-github --name eyes             # uploads local source tarball, no GitHub needed (hackathon-friendly)
npx mcp-use deploy --root-dir apps/mcp --env KEY=VAL --env-file .env.production --region US --yes
npx mcp-use deployments list --server <id>; npx mcp-use deployments get <dep-id>
npx mcp-use deployments logs <dep-id> --build --follow   # build logs
npx mcp-use deployments logs <dep-id>                    # runtime logs
npx mcp-use servers env set <srv> KEY=VAL --secret       # (local CLI ref)  docs.manufact.com lists `servers env add|update|remove`; run `npx mcp-use servers env --help`
```
- `deploy` does not wait for build to finish (deployment guide). Redeploy = run `deploy` again (link file `.mcp-use/project.json` per cli ref, `.mcp-use/cloud/link.json` per deployment guide; docs disagree, file is auto-gitignored). Env var changes do NOT restart the server: redeploy after changing (environment-variables page).
- Build detection: Node via `package.json` + lockfile; pnpm supported; `packageManager` field wins via Corepack, else pnpm 10 default; runs `build` and `start` scripts by default; override with `--build-command/--start-command` (build-runtimes page). pnpm 10 skips dependency build scripts (add to `onlyBuiltDependencies`); pnpm 11 fails with `ERR_PNPM_IGNORED_BUILDS`. A committed `Dockerfile` is used as-is.
- Monorepo: use `--root-dir <app dir>`; `--watch-paths` for shared pkgs. Safest: make the MCP app directory self-contained (own package.json, no `workspace:*` deps) OR bundle workspace code at build time. Not documented whether Manufact runs install at monorepo root; verify on first deploy.
- Scripts the app needs (generated by `create-mcp-use-app`): `"dev": "mcp-use dev"`, `"build": "mcp-use build"`, `"start": "mcp-use start"`. `build` writes `.mcp-use/build/index.js`; `start` binds `PORT` (default 3000). `start` default host is `127.0.0.1`; set `HOST=0.0.0.0` or `start --host 0.0.0.0` if the platform health-check cannot reach it (platform may handle; unverified).
- Regions: `US`/`EU`/`APAC` (cli ref); `AUTO`/`GLOBAL` also listed on docs.manufact.com. Non-AUTO region needs Startup plan; Free plan covers first server (quickstart).
- Logs: dashboard Runtime logs tab streams stdout/stderr of the running deployment; Gateway Requests tab shows every gateway request, payload capture off by default (observability page).

## Local dev + testing
- `npm run dev` / `npx mcp-use dev`: MCP at `http://localhost:3000/mcp`, Inspector at `http://localhost:3000/mcp/inspector` (server/index.mdx). Tunnel: `mcp-use dev --tunnel` gives a public URL (webhook testing).
- Programmatic without sockets (VERIFIED-LOCAL): `server.fetch(new Request(url, init))` returns a `Response`; works for custom routes (`await server.fetch(new Request("http://localhost/llms.txt"))` gave 200 `hi`) and `/mcp` JSON-RPC (send `accept: application/json, text/event-stream`, send `initialize` first; response is SSE `event: message`).
- Full-client test: `import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"` with `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer …" } } })`, then `client.connect`, `listTools`, `callTool({name, arguments}, { onprogress, timeout, resetTimeoutOnProgress: true })` (VERIFIED-LOCAL). Use `127.0.0.1` rather than `localhost` in raw curl; raw curl calls to `/mcp` other than `initialize` returned 400 without a session-style flow, so prefer the SDK client or `npx mcp-use client connect <name> <url>` then `npx mcp-use client <name> tools list`.
- Tests: put logic in plain functions, call those directly; one smoke test via `server.fetch`.

## Connecting clients (live demo)
- Dashboard: click gateway URL chip, "Add to client" gives one-click installs/copy-paste for Claude Desktop and Claude Code (connect-clients page).
- Generic JSON: `{ "mcpServers": { "eyes": { "url": "https://<slug>.run.mcp-use.com/mcp" } } }`.
- Claude Code with our bearer key: `claude mcp add --transport http eyes https://<slug>.run.mcp-use.com/mcp --header "Authorization: Bearer $EYES_KEY"`; `.mcp.json`: `{"mcpServers":{"eyes":{"type":"http","url":"…/mcp","headers":{"Authorization":"Bearer ${EYES_KEY}"}}}}` (code.claude.com/docs/en/mcp). Do not name the env var like `ANTHROPIC_*`; those expand to empty.
- Claude Desktop / ChatGPT remote connectors generally expect OAuth or no auth, not static bearer headers (unverified, see Open questions). For the demo, use Claude Code or the mcp-use client with the header, or make a demo key optional.

## Limits, test-mode quirks, gotchas
- Server is **stateless** in v2: no MCP sessions; GET/DELETE on `/mcp` return 204/405. Never hold state in memory between calls; all state in InsForge.
- Progress/notifications only on the active request stream; no async push to the client later (notifications.mdx).
- `outputSchema` tools must return matching `structuredContent` on success; mismatch fails. Keep `outputSchema` loose enough for both success states.
- Node >= 22.22.2 required locally and (presumably) on the platform; set `"engines"` in package.json.
- `mcp-use build` is transpile-only; run `tsc --noEmit` yourself.
- First-server free plan only; region pinning needs paid plan.
- Env changes require redeploy.
- Default bind is loopback; remember `HOST=0.0.0.0` for any self-hosted fallback (e.g. a Railway/Fly Dockerfile).
- The local test printed a harmless Node `ExperimentalWarning: localStorage` message.

## Contradictions with our plan
- Plan: "require a bearer API key via mcp-use". Docs: only OAuth providers are built in; static keys need our own Hono middleware (works, verified). https://docs.manufact.com / server/authentication/index.mdx.
- Plan: webhook, REST mirror and static files on the MCP server. Docs: custom Hono routes work locally with raw body; the Manufact gateway's handling of non-`/mcp` paths is undocumented (https://docs.manufact.com/dashboard/quickstart).
- Plan: 120s long-poll. Claude Code per-server timeout is a hard wall clock and ignores progress; gateway timeout undocumented. Split into <=60s calls.
- Plan: "npx mcp-use deploy" implies simple deploy. Default needs GitHub origin + GitHub App; use `--no-github` for local upload (docs.manufact.com/cli/deploy).
- Plan: `/llms.txt` etc. via static files. `public/` is only served under `/mcp/_mcp-use/public/`; use custom routes.

## Open questions / unverified
- UNVERIFIED: does `https://<slug>.run.mcp-use.com` route paths other than `/mcp` (webhooks, `/v1/*`, `/llms.txt`, `/.well-known/agent-card.json`) to our Hono app? Test on first deploy; fallback is InsForge functions for those.
- UNVERIFIED: gateway request timeout and whether it forwards `Authorization` and streams SSE progress.
- UNVERIFIED: pnpm workspace monorepo install behavior with `--root-dir` (workspace deps); safest is a self-contained app dir or `--no-github` upload from that dir.
- UNVERIFIED: link file name (`.mcp-use/project.json` vs `.mcp-use/cloud/link.json`) and `servers env` subcommand names (`set/unset` in local docs vs `add/update/remove` on docs.manufact.com); check `--help`.
- UNVERIFIED: ChatGPT connector setup (OpenAI developer-mode doc URL 404'd). Claude Desktop remote connector with static bearer header not confirmed.
- UNVERIFIED: Manufact API key page contents (https://docs.manufact.com/dashboard/api-keys not read), Armature/analytics integration with Manufact, `Public Chat`/`Testing` page contents.
- Raw `curl` JSON-RPC to `/mcp` other than `initialize` returned HTTP 400 in my test (cause not diagnosed; SDK client works).
