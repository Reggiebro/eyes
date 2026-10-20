// api.eyes.pictures: a pass-through to the Eyes server, so agents and the app use one stable name.
// Without ORIGIN the server runs in a Cloudflare Container (one instance, the Dockerfile at the repo
// root) managed by the EyesServer Durable Object below. With ORIGIN set (Manufact Cloud, e.g.
// `--var ORIGIN:https://<slug>.run.mcp-use.com`, or the Mac tunnel for a rollback) every request on
// every host goes there and the container is never started, so only one server runs sweeps/payouts.
// EDGE_SECRET (a Worker secret, same value in the server's env) proves to the server that the
// client IP and host headers below came from this Worker.
import { DurableObject } from "cloudflare:workers";

const PORT = 3000;
const READY_WAIT_MS = 60_000;
// Larger bodies (photo uploads) stream once on the normal path instead of being held in memory.
const BUFFER_MAX_BYTES = 1024 * 1024;
// The runtime's errors when nothing reached the server: no process listening on the port (booting,
// or draining after SIGTERM in a rollout), the process has exited and the instance is not running,
// or no instance is free yet (max_instances 1 while the old one stops). Texts seen live during a
// rollout: "The container is not running, consider calling start()" and "The container is not
// listening in the TCP address 10.0.0.1:3000". Any other error may come after the server got the
// request, so that request is never replayed.
const NOT_DELIVERED = /container is not (listening|running)|no container instance that can be provided/i;

function notDelivered(err) {
  return NOT_DELIVERED.test(String(err?.message));
}

function unavailable(status, err) {
  return new Response(`Eyes server unavailable: ${err?.message}`, { status });
}

// ponytail: the cron touches the Durable Object every minute, so this only matters if cron stops.
const INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export class EyesServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  // Start the container if it is not running. No HTTP request to the server, so the keep-alive
  // never shows up in the server's request log or ops metrics.
  async ensure() {
    const container = this.ctx.container;
    if (container.running) return false;
    const env = {};
    for (const [key, value] of Object.entries(this.env)) {
      if (typeof value === "string" && key !== "ORIGIN") env[key] = value;
    }
    container.start({ env, enableInternet: true });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    container.monitor().catch((err) => console.error("eyes container exited with an error", err));
    return true;
  }

  // With ORIGIN serving traffic, a container still running from before would run a second set of
  // sweeps and payout loops. First tick: SIGTERM, so the server drains like in a rollout; a later
  // tick that still finds it running destroys it.
  async stop() {
    const container = this.ctx.container;
    if (!container.running) return false;
    if (this.stopping) {
      console.log("eyes container still running after SIGTERM: destroying it (ORIGIN is set)");
      await container.destroy();
    } else {
      console.log("eyes container running while ORIGIN is set: sending SIGTERM");
      container.signal(15);
      this.stopping = true;
    }
    return true;
  }

  async fetch(request) {
    if (await this.ensure()) this.ready = false;
    const length = request.headers.get("content-length");
    const small = length !== null && Number(length) <= BUFFER_MAX_BYTES;
    if (this.ready && request.body && !small) {
      try {
        return await this.ctx.container.getTcpPort(PORT).fetch(request);
      } catch (err) {
        // A streamed body cannot be replayed: answer now; the next request waits for the restart.
        if (!notDelivered(err)) return unavailable(502, err);
        this.ready = false;
        return unavailable(503, err);
      }
    }
    // Buffer the body so a request the server never received can be replayed while it (re)starts.
    const init = { method: request.method, headers: request.headers, redirect: "manual" };
    if (request.body) init.body = await request.arrayBuffer();
    const deadline = Date.now() + READY_WAIT_MS;
    for (;;) {
      try {
        const response = await this.ctx.container.getTcpPort(PORT).fetch(request.url, init);
        this.ready = true;
        return response;
      } catch (err) {
        if (!notDelivered(err)) return unavailable(502, err);
        this.ready = false;
        if (Date.now() > deadline) return unavailable(503, err);
        await new Promise((resolve) => setTimeout(resolve, 500));
        // After a rollout's SIGTERM the old process exits; start the new image once it has.
        await this.ensure();
      }
    }
  }
}

function server(env) {
  return env.EYES.get(env.EYES.idFromName("main"));
}

// Manufact's gateway rewrites OAuth discovery to name its own host: the protected-resource
// metadata's `resource` (keeping ours as `_original_resource`) and the 401's WWW-Authenticate
// resource_metadata URL. MCP clients reject a resource that differs from the URL they connected
// to, so put the public host back.
async function fromOrigin(response, url, origin) {
  const originUrl = new URL(origin);
  const auth = response.headers.get("www-authenticate") ?? "";
  const publicAuth = auth.replace(/resource_metadata="([^"]+)"/g, (match, value) => {
    try {
      const metadataUrl = new URL(value);
      return metadataUrl.origin === originUrl.origin &&
        ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(
          metadataUrl.pathname,
        )
        ? `resource_metadata="${url.origin}${metadataUrl.pathname}${metadataUrl.search}"`
        : match;
    } catch {
      return match;
    }
  });
  const isMetadata = [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ].includes(url.pathname);
  const headers = new Headers(response.headers);
  if (publicAuth) headers.set("www-authenticate", publicAuth);
  let body = response.body;
  let rewritten = false;
  if (isMetadata && response.ok && headers.get("content-type")?.includes("application/json")) {
    const metadata = await response
      .clone()
      .json()
      .catch(() => null);
    if (metadata && !Array.isArray(metadata) && typeof metadata.resource === "string") {
      metadata.resource = `${url.origin}/mcp`;
      delete metadata._original_resource;
      body = JSON.stringify(metadata);
      rewritten = true;
      for (const header of [
        "content-length",
        "content-encoding",
        "etag",
        "content-md5",
        "content-digest",
        "repr-digest",
      ])
        headers.delete(header);
    }
  }
  if (!rewritten && publicAuth === auth) return response;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: rewritten ? "automatic" : "manual",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.href, 308);
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", url.host);
    // The server rate-limits by the last x-forwarded-for entry; a client-sent value would pass
    // straight through, so replace it with the address Cloudflare saw.
    const ip = request.headers.get("cf-connecting-ip") ?? "";
    headers.set("x-forwarded-for", ip);
    // Proxies in front of ORIGIN append to x-forwarded-for and may rewrite x-forwarded-host; the
    // server trusts these copies only next to the matching secret.
    headers.set("x-eyes-client-ip", ip);
    headers.set("x-eyes-host", url.host);
    headers.set("x-eyes-edge-secret", env.EDGE_SECRET ?? "");
    const init = { method: request.method, headers, body: request.body, redirect: "manual" };
    const upstream = env.ORIGIN
      ? await fromOrigin(await fetch(new URL(url.pathname + url.search, env.ORIGIN), init), url, env.ORIGIN)
      : await server(env).fetch(new Request(`http://eyes${url.pathname}${url.search}`, init));
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
      encodeBody: "manual",
    });
    response.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("x-frame-options", "DENY");
    response.headers.set("permissions-policy", "camera=(self), geolocation=(self), microphone=()");
    return response;
  },

  async scheduled(_event, env) {
    // Keep the origin warm and stop any container left from before; never start one while ORIGIN
    // serves traffic.
    if (env.ORIGIN) {
      await fetch(new URL("/healthz", env.ORIGIN)).catch((err) => console.error("origin ping failed", err));
      await server(env).stop();
      return;
    }
    await server(env).ensure();
  },
};
