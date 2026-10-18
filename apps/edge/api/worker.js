// api.eyes.pictures: a pass-through to the Eyes server, so agents and the app use one stable name.
// The server runs in a Cloudflare Container (one instance, the Dockerfile at the repo root) managed
// by the EyesServer Durable Object below. Rollback to the Mac: deploy with ORIGIN set to the tunnel
// (`--var ORIGIN:https://eyes-dispatch.inkboxwire.com`); while ORIGIN is set, api.eyes.pictures
// proxies there and only the workers.dev URL reaches the container.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", url.host);
    // The server rate-limits by the last x-forwarded-for entry; a client-sent value would pass
    // straight through, so replace it with the address Cloudflare saw.
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
    const init = { method: request.method, headers, body: request.body, redirect: "manual" };
    if (env.ORIGIN && !url.hostname.endsWith(".workers.dev")) {
      return fetch(new URL(url.pathname + url.search, env.ORIGIN), init);
    }
    return server(env).fetch(new Request(`http://eyes${url.pathname}${url.search}`, init));
  },

  async scheduled(_event, env) {
    await server(env).ensure();
  },
};
