# Armature - vendor note
Fetched: 2026-10-16. Sources (all read):
- https://ycombinator.com/companies/armature
- https://runtimewire.com/article/armature-product-analytics-evals-agent-sessions-mcp
- https://docs.armature.tech/llms.txt
- https://docs.armature.tech/quickstart.md
- https://docs.armature.tech/how-it-works.md
- https://docs.armature.tech/sdks/typescript.md
- https://docs.armature.tech/sdks/telemetry.md
- https://docs.armature.tech/sdks/identifying-users.md
- https://docs.armature.tech/sdks/stateless-servers.md
- https://docs.armature.tech/evaluation/overview.md
- https://docs.armature.tech/evaluation/eval-cases.md
- https://docs.armature.tech/evaluation/suites-and-runs.md
- https://docs.armature.tech/evaluation/ci.md
- https://docs.armature.tech/agent-discoverability/scanner-methodology.md
- https://api-reference.mcp-use.com/classes/mcp-use.index.MCPServer.html

## Which Armature
Armature = YC Spring 2026 startup, Paris/SF, site https://armature.tech, docs https://docs.armature.tech (has /llms.txt and per-page .md), dashboard https://app.armature.tech (EU: https://eu.armature.tech), contact founders@armature.tech / contact@armature.tech. Founders Theodore Otzenberger, Louis Scremin. (ycombinator.com/companies/armature)
It is the AX / MCP-analytics company: "product analytics and evals for agent sessions on your MCP". It also sells an "agent discoverability" scanner and AI-crawler traffic analytics. Other companies named Armature exist generically; this one is the only one tied to agents/MCP/AX, and docs.armature.tech confirms the product. That Armature sponsors the YC "Make Something Agents Want" AX prize is NOT confirmed from any source I could read (see Open questions).

## What Eyes uses it for
1. Instrument the Eyes MCP server so every agent session (tool calls, errors, latency, client name, intent) shows in the Armature dashboard. This is the hackathon-prize evidence for AX.
2. Use Armature evals: a tester agent (Claude in Claude Code, GPT in Codex) connects to our DEPLOYED MCP URL and tries goals like "ask a physical-world question and get a verified answer"; a judge scores 0-5 against our criteria.
3. Use their published AX checklist (scanner methodology) to shape llms.txt, agents.md, OpenAPI, MCP registry presence for the Eyes site.

## Auth & setup
Env vars (exact names, from https://docs.armature.tech/sdks/typescript.md and /quickstart.md):
- `ANALYTICS_INGEST_API_KEY`: per-MCP-server ingest key. Shown ONCE. If missing, SDK silently no-ops (schemas still decorated, nothing sent).
- `ANALYTICS_INGEST_URL`: region ingest URL. US workspaces may omit (SDK defaults to US). EU must set `https://eu.armature.tech/api/mcp-analytics/ingest`.
- `ARMATURE_API_KEY` (only for CI/eval API; docs use this name in examples but do not mandate it): dashboard Settings -> API keys; member needs editor/admin/owner role. (evaluation/ci.md)

Where a human gets them:
1. Sign in at https://app.armature.tech -> MCP Setup -> "Add MCP server" -> register the server.
2. On the server card click "Connect SDK analytics" -> copy key + ingest URL (shown once; rotate/revoke on same card). One key per MCP server.
3. Put both in the deployment secrets (Manufact Cloud env) and local .env.
No test/live split is documented; analytics is just a workspace. Free tier: first 1,000 sessions/month, 7-day retention, $50 per extra 1,000 (pricing per runtimewire article, secondary source; not verified on an Armature pricing page).
Evaluation may be disabled per workspace: if the "Evaluation" section is missing, email contact@armature.tech (evaluation/overview.md). Do this EARLY.

## Exact SDK/API calls

### Package
`npm install @armature-tech/mcp-analytics`
Optional peers: `@modelcontextprotocol/sdk` (`>=1.20 <2`; use 1.29+ if tools use Zod 4 raw shapes) for package root, `/mastra` subpath and `doctor` CLI; `@modelcontextprotocol/server` 2.x for the `/v2` subpath. Docs list supported frameworks: official MCP TS SDK (1.x, 2.x), Mastra, punkpeye/fastmcp, Vercel mcp-handler. mcp-use is NOT listed. (sdks/typescript.md)

### Init (official SDK pattern; source https://docs.armature.tech/sdks/typescript.md)
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";
import { z } from "zod";

const server = createMcpAnalyticsServer(() => {
  const mcp = new McpServer({ name: "customer-mcp", version: "1.0.0" });
  mcp.registerTool("lookup_customer",
    { description: "Look up a customer by ID", inputSchema: { customer_id: z.string() } },
    async ({ customer_id }) => ({ content: [{ type: "text", text: `customer ${customer_id} is active` }] }));
  return mcp;
});
await server.connect(new StdioServerTransport());
```
`createMcpAnalyticsServer(buildServer, { armature: {...} })`. The factory takes a function that builds the McpServer, so it is compatible with per-request server construction.

### Options (under `armature` key)
| Option | Default | Notes |
|---|---|---|
| apiKey | env ANALYTICS_INGEST_API_KEY | |
| endpointUrl | US ingest | or env ANALYTICS_INGEST_URL |
| enabled | true | false disables capture |
| delivery | "background" | "await" for serverless (events sent before return) |
| timeoutMs | 5000 | |
| actorId | derived from request auth | string or resolver, hashed SHA-256 before sending |
| actorIdentifier | none | sent UNHASHED, shown in dashboard |
| emit | network emitter | replace delivery (tests) |
| onError | console.warn | delivery failures never reach tools |
| captureTelemetry | true | false disables conversation-derived telemetry |
| requestCapability | on | injects `request_capability` tool; false disables |

### Identify users (https://docs.armature.tech/sdks/identifying-users.md)
```ts
createMcpAnalyticsServer(buildServer, { armature: {
  actorId: (context) => context?.authInfo?.principalId ?? "anonymous",
  actorIdentifier: (context) => lookupUserEmail(context),
}});
```
Eyes: map actorId to our agent_id (API key owner). Do not put PII in actorIdentifier (agent name/label is fine). Never put worker phone numbers or coordinates there.

### Flush on shutdown (background delivery)
```ts
import { withMcpAnalytics } from "@armature-tech/mcp-analytics";
const { result: server, recorder } = withMcpAnalytics({}, buildServer);
process.on("SIGTERM", async () => { await recorder.flush(); process.exit(0); });
```

### Stateless / serverless (https://docs.armature.tech/sdks/stateless-servers.md)
Set `armature: { delivery: "await" }`. Per request call `resolveStatelessHttpSession(body, headers)`; pass its `sessionIdGenerator` to `StreamableHTTPServerTransport` and merge its `dispatchContext` into the context passed to `analytics.dispatch`. Without it, sessions merge and client shows "Unknown". Session IDs are unsigned attribution only, not auth. Exact signatures were not shown in the page I could read; check the package types.

### What gets captured (https://docs.armature.tech/sdks/telemetry.md)
- Optional `telemetry` object injected into every instrumented tool's input schema, stripped before the handler: `user_intent`, `agent_thinking`, `user_frustration` ("low"|"medium"|"high"). Implication: our tool JSON schemas visible to agents will show an extra optional `telemetry` param. Set `captureTelemetry:false` if that hurts tool clarity.
- `session_init` event (client name/version, protocol version, capabilities).
- `tool_call` event: tool name, timestamps, duration, outcome (incl. `isError: true` results), telemetry fields, truncated input/result previews (8 KiB each).
- Auto-added tool `request_capability`: agents call it when no tool meets their need (a free demand signal; e.g. "verify a restaurant is open at night"). Our own tool of same name wins.
- Session id = `Mcp-Session-Id` header (HTTP) or process id (stdio). Actor = SHA-256 of auth-derived seed, else `anonymous`.
- Other limits: script source 32 KiB, client capabilities 4 KiB.
- Pipeline (how-it-works.md): idle session -> judge rates Succeeded/Partial/Failed -> intents clustered into Use cases -> failures clustered into Issues (auto-archived after 3 weeks idle). Dashboard pages: Overview, Sessions & replay, Use cases, Issues, Workspace.

### Armature's own MCP (query analytics from Claude Code)
Docs at https://docs.armature.tech/armature-mcp/connect.md and /tools.md (NOT read). Tools named in docs I read: `run_eval_suite`, `get_suite_run`, `list_eval_cases`.

### Evals (https://docs.armature.tech/evaluation/*.md)
- Setup: register server URL in MCP Setup with credentials if needed. Must be a deployed URL (tester connects over HTTP). Eyes needs a test-mode agent API key for the tester; the docs do not say how credentials are supplied (UI field in MCP Setup presumably).
- Case = prompt written as a GOAL (not click path) + criteria (each marked required/optional) + targets (model in harness; new targets: Claude model in Claude Code, GPT model in Codex) + optional schedule.
- Criteria rules: outcome checkable by outside observer; one behavior each; state side effects to avoid; name expected evidence; scope test data names per run; criteria not exercised are N/A and do not count.
- Score: 5 all applied pass; 4 required pass, an optional short; 3 no required failed but one partial; 2 exactly one required failed; 1 two+ required failed; 0 tester never engaged. Outcome: Passed 4-5, Partial 2-3, Failed 0-1 or crash/timeout.
- Plans: Free = 1 target/case, no schedules, 100 finished runs/month. Starter 2 targets, 3 scheduled. Pro 4 targets, 25 scheduled.
- Create cases from dashboard, or from a Use case / Issue via "Create eval".
- CI: `POST https://app.armature.tech/api/armature/v1/workflows/<EVAL_CASE_ID>/runs` with `Authorization: Bearer $ARMATURE_API_KEY`, body `{"reason": "...", "idempotencyKey"?: "...", "testerTargets"?: [{"modelId": "<id>"}]}` -> 202 + run id. Read: `GET /api/armature/v1/runs/<RUN_ID>` (status+score; poll) and `GET .../runs/<RUN_ID>/evaluation` (criterion marks+evidence). JSON shapes and status values are undocumented. Trigger runs one at a time (burst rate limit). Suite runs have no HTTP endpoint.

Suggested Eyes eval cases (goal prompts):
1. "Using only the tools and their descriptions, find out whether the cafe at <address> currently has a line, and give me a verified answer." Required: agent reads tool list before acting; calls create-request with question+location+bounty+deadline; polls/receives structured answer; no unexpected tool errors.
2. "Check my balance, then top up if insufficient" (funding path). Required: agent gets a Stripe Checkout URL without human guessing parameters.
3. Expiry path: deadline passes, agent sees refund and a clear status.

## Webhooks / inbound
None. Armature is outbound-only from our server (SDK POSTs events to ingest URL). No inbound webhooks, signatures or retries documented. Delivery errors go to `onError`, never into tools.

## Limits, test-mode quirks, gotchas
- Missing/typo'd `ANALYTICS_INGEST_API_KEY` = silent no-op. Verify with one live conversation; it should appear under Sessions within 1-2 minutes (quickstart.md).
- Ingest rejections can arrive "in-body"; wire `onError` to a logger during the demo.
- Serverless freezes after response: use `delivery:"await"` or events are lost. Manufact Cloud runtime semantics unverified.
- Injected `telemetry` param and `request_capability` tool change the tool list the agent sees; review so they do not confuse the Eyes tool descriptions or bloat tokens.
- Input/result previews are captured (8 KiB). Do not return worker phone numbers, exact worker GPS, or photo URLs with secrets in tool results, or they land in Armature. Check /security/privacy.md (not read).
- Eval free tier: 100 finished runs/month pooled; run counts only when finished. Evaluation is gated per workspace.
- Evals hit the real deployed server: they would create real requests, SMS dispatches and escrow. Point the tester at a staging/test-mode Eyes deployment with a dispatch kill-switch or sandbox worker, and scope data names per run.
- Free retention 7 days: fine for a weekend hackathon, screenshot dashboards before they age out.

## Contradictions with our plan
- Plan: "Armature MCP analytics works with our mcp-use server". Docs: only the official MCP TS SDK, Mastra, fastmcp, mcp-handler are supported; mcp-use not listed. mcp-use builds a fresh SDK `McpServer` per HTTP request from its registry and exposes no accessor to it (https://api-reference.mcp-use.com/classes/mcp-use.index.MCPServer.html). So `createMcpAnalyticsServer(() => new McpServer())` cannot wrap an mcp-use server directly. Integration route is UNVERIFIED (see below).
- Plan: "Armature gives agent-identity/client analytics". Docs: client name/version come from `session_init`; user identity needs our `actorId` resolver; unauthenticated = `anonymous`. Not automatic.
- Plan: "evals across clients, run in test mode". Docs: targets are only Claude-in-Claude-Code and GPT-in-Codex style harnesses, free plan = 1 target/case, and no test-mode concept; the tester hits whatever URL you register.
- Plan: "docs-only agent completes sign-up". Evals use our MCP tool list plus the prompt; the tester does not browse our docs site. Docs/llms.txt quality is measured by the separate scanner, not by the eval.

## Open questions / unverified
- UNVERIFIED: that Armature is the sponsor of the YC "Make Something Agents Want" AX prize and what the prize criteria are. Searches found no hackathon page. Ask the sponsor booth at the event; also ask for a workspace with Evaluation enabled.
- UNVERIFIED: mcp-use compatibility. Candidate approaches, none confirmed: (a) the wrapper's `dispatch` API (`analytics.dispatch` appears in stateless-servers.md) fed from mcp-use `server.use("mcp:tools/call", ...)` middleware or read-only `server.on("mcp:tools/call:complete", ...)` observers (both exist per mcp-use API reference), (b) custom `emit` plus ingest wire format (wire format "shared by four SDKs" but not published in pages I read; /.armature/openapi.json listed in llms.txt but not read, may describe ingest), (c) run the Eyes MCP as plain `@modelcontextprotocol/sdk` McpServer on Manufact if it accepts that, (d) ask Armature founders (founders@armature.tech) at the event. First builder task: read https://docs.armature.tech/.armature/openapi.json and the package's TypeScript types (`npm view @armature-tech/mcp-analytics` then inspect dist/*.d.ts) before choosing.
- Not read: /sdks/python, /dashboard/*, /armature-mcp/*, /security/privacy, /ai-traffic/*. Armature MCP endpoint URL unknown.
- Eval target model IDs (`testerTargets[].modelId` values) unpublished; get from dashboard.
- Pricing figures come from runtimewire only.

## Armature's definition of good AX (concrete, from the scanner methodology page)
Source: https://docs.armature.tech/agent-discoverability/scanner-methodology.md. 45 tests, no score, each Pass/Warning/Fail/N-A. The scanner targets a product website; applying it to the Eyes site/MCP endpoint is our inference.
Agent access (22): public HTTPS homepage with useful content; one canonical host; server-rendered HTML with name, description, h1; robots.txt allows search crawlers and `ChatGPT-User`, `Claude-User`; no bot challenges for crawlers; sitemap at standard path declared in robots.txt with valid URLs and `lastmod`; docs linked from homepage, first-party domain, readable without login/CAPTCHA; `/llms.txt` or `/.well-known/llms.txt` with title, short description, grouped official links whose links resolve; `/agents.md` (purpose, supported tasks, limits, official resources); advertised Markdown alternates and `Accept: text/markdown` content negotiation; HTTP `Link` headers exposing 2+ first-party resources; consistent canonical/title/description/Open Graph; pages within bounded token size.
Distribution (21): `/.well-known/ai-catalog.json` (ARD catalog) with stable IDs; Agent Skills index; A2A agent card; public valid OpenAPI 3 doc; RFC 9727 API catalog; public MCP endpoint tied to domain; Official MCP Registry entry; listings in OpenAI Apps, Claude Connectors, Vercel Marketplace, Context7, Smithery, mcp.so, Glama, PulseMCP, skills.sh; public GitHub repo with `AGENTS.md`/`SKILL.md`; official packages linking back; developer portal page (setup, reference, examples, updates, support).
Search (2): exact brand search returns first-party result; "brand + developer docs API MCP" returns official dev resources.
Eval-side AX (eval-cases.md): tools must let an agent succeed from a goal alone; failures are judged on outcome evidence, so tool errors must be explicit and recoverable (`isError: true` with actionable text).
Cheap wins for Eyes in a weekend: llms.txt, agents.md, OpenAPI for the REST bits, robots allowing Claude-User/ChatGPT-User, server-rendered landing page, MCP endpoint linked from homepage, GitHub repo with AGENTS.md.
