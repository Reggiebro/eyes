import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
// @ts-expect-error untyped worker module; the Workers types are not in this package.
import worker, { EyesServer } from "./worker.js";

// The Durable Object base class only exists in the Workers runtime. Keep the same constructor contract.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const INACTIVITY_MS = 6 * 60 * 60 * 1000;

type FakeFetch = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

interface FakePort {
  fetch: Mock<FakeFetch>;
}

interface FakeContainerOptions {
  running?: boolean;
  port?: FakePort;
  monitor?: () => Promise<void>;
}

interface FakeContainer {
  running: boolean;
  port: FakePort;
  start: Mock<() => void>;
  setInactivityTimeout: Mock<(ms: number) => Promise<void>>;
  monitor: () => Promise<void>;
  getTcpPort: Mock<() => FakePort>;
  signal: Mock<(signo: number) => void>;
  destroy: Mock<() => Promise<void>>;
}

interface FakeStub {
  fetch: Mock<(request: Request) => Promise<Response>>;
  ensure: Mock<() => Promise<boolean>>;
  stop: Mock<() => Promise<boolean>>;
}

function fakePort(): FakePort {
  return { fetch: vi.fn<FakeFetch>(async () => new Response("ok", { status: 200 })) };
}

function fakeContainer(options: FakeContainerOptions = {}): FakeContainer {
  const container: FakeContainer = {
    running: options.running ?? false,
    port: options.port ?? fakePort(),
    start: vi.fn(() => {
      container.running = true;
    }),
    setInactivityTimeout: vi.fn(async (_ms: number) => {}),
    monitor: options.monitor ?? (() => Promise.resolve()),
    getTcpPort: vi.fn(() => container.port),
    signal: vi.fn((_signo: number) => {}),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
  };
  return container;
}

function fakeCtx(container: FakeContainer) {
  return { container, blockConcurrencyWhile: vi.fn((fn: () => unknown) => fn()) };
}

function fakeStub(): FakeStub {
  return {
    fetch: vi.fn(async (_request: Request) => new Response("routed", { status: 200 })),
    ensure: vi.fn(async () => false),
    stop: vi.fn(async () => false),
  };
}

function fakeEnv(stub: FakeStub, extra: Record<string, unknown> = {}) {
  return {
    EYES: { idFromName: vi.fn((name: string) => `id-${name}`), get: vi.fn(() => stub) },
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api worker routing", () => {
  it("forwards every host and path to ORIGIN with method, body, and edge headers, redirect manual", async () => {
    const stub = fakeStub();
    const upstream = vi.fn(async (_input: URL | string, _init?: RequestInit) => new Response("from origin"));
    vi.stubGlobal("fetch", upstream);
    const env = fakeEnv(stub, { ORIGIN: "https://eyes.run.mcp-use.com", EDGE_SECRET: "s3cret" });

    const res = await worker.fetch(new Request("https://api.eyes.pictures/v1/tasks?limit=2"), env);
    await worker.fetch(new Request("https://eyes-api.someone.workers.dev/healthz?x=1"), env);
    await worker.fetch(
      new Request("https://internal.eyes.pictures/login", {
        method: "POST",
        body: "a=1",
        headers: { "cf-connecting-ip": "203.0.113.9", "x-eyes-client-ip": "6.6.6.6" },
      }),
      env,
    );

    expect(await res.text()).toBe("from origin");
    expect(upstream.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://eyes.run.mcp-use.com/v1/tasks?limit=2",
      "https://eyes.run.mcp-use.com/healthz?x=1",
      "https://eyes.run.mcp-use.com/login",
    ]);
    const init = upstream.mock.calls[2]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(await new Response(init.body).text()).toBe("a=1");
    expect(headers.get("x-forwarded-host")).toBe("internal.eyes.pictures");
    expect(headers.get("x-eyes-host")).toBe("internal.eyes.pictures");
    expect(headers.get("x-eyes-client-ip")).toBe("203.0.113.9");
    expect(headers.get("x-eyes-edge-secret")).toBe("s3cret");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("passes a streamed ORIGIN response through untouched", async () => {
    const body = new ReadableStream({ start: (c) => c.close() });
    const upstream = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstream),
    );

    const res = await worker.fetch(
      new Request("https://api.eyes.pictures/mcp"),
      fakeEnv(fakeStub(), { ORIGIN: "https://eyes.run.mcp-use.com" }),
    );

    expect(res).toBe(upstream);
  });

  it("sends an empty edge secret when EDGE_SECRET is unset, overriding a client-sent one", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", {
      headers: { "x-eyes-edge-secret": "guess" },
    });

    await worker.fetch(req, fakeEnv(stub));

    expect(stub.fetch.mock.calls[0]?.[0].headers.get("x-eyes-edge-secret")).toBe("");
  });

  it("sends everything to the container when ORIGIN is not set", async () => {
    const stub = fakeStub();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    await worker.fetch(new Request("https://api.eyes.pictures/v1/agents"), fakeEnv(stub));

    expect(upstream).not.toHaveBeenCalled();
    expect(stub.fetch).toHaveBeenCalledOnce();
    expect(stub.fetch.mock.calls[0]?.[0].url).toBe("http://eyes/v1/agents");
  });

  it("replaces a client-sent x-forwarded-for with cf-connecting-ip and sets x-forwarded-host", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", {
      headers: { "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(req, fakeEnv(stub));

    const forwarded = stub.fetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(forwarded?.headers.get("x-forwarded-host")).toBe("api.eyes.pictures");
  });

  it("sets x-forwarded-for to empty when Cloudflare sent no cf-connecting-ip", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", {
      headers: { "x-forwarded-for": "6.6.6.6" },
    });

    await worker.fetch(req, fakeEnv(stub));

    expect(stub.fetch.mock.calls[0]?.[0].headers.get("x-forwarded-for")).toBe("");
  });

  it("removes the host header before it reaches the server", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", { headers: { host: "evil.example" } });

    await worker.fetch(req, fakeEnv(stub));

    expect(stub.fetch.mock.calls[0]?.[0].headers.get("host")).toBeNull();
  });

  it("scheduled() with ORIGIN pings ORIGIN /healthz and stops, never ensures, the container", async () => {
    const stub = fakeStub();
    const upstream = vi.fn(async (_input: URL | string) => new Response("ok"));
    vi.stubGlobal("fetch", upstream);
    const env = fakeEnv(stub, { ORIGIN: "https://eyes.run.mcp-use.com" });

    await worker.scheduled({}, env);
    upstream.mockRejectedValueOnce(new Error("down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.scheduled({}, env);

    expect(upstream.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://eyes.run.mcp-use.com/healthz",
      "https://eyes.run.mcp-use.com/healthz",
    ]);
    expect(error).toHaveBeenCalledWith("origin ping failed", expect.any(Error));
    expect(env.EYES.idFromName).toHaveBeenCalledWith("main");
    expect(stub.stop).toHaveBeenCalledTimes(2);
    expect(stub.ensure).not.toHaveBeenCalled();
  });

  it("scheduled() calls ensure() on the main Durable Object", async () => {
    const stub = fakeStub();
    const env = fakeEnv(stub);

    await worker.scheduled({}, env);

    expect(env.EYES.idFromName).toHaveBeenCalledWith("main");
    expect(stub.ensure).toHaveBeenCalledOnce();
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("EyesServer", () => {
  it("applies the inactivity timeout on construction only when the container is running", () => {
    const running = fakeContainer({ running: true });
    new EyesServer(fakeCtx(running), {});
    expect(running.setInactivityTimeout).toHaveBeenCalledWith(INACTIVITY_MS);

    const idle = fakeContainer({ running: false });
    const ctx = fakeCtx(idle);
    new EyesServer(ctx, {});
    expect(ctx.blockConcurrencyWhile).not.toHaveBeenCalled();
  });

  it("stop() does nothing when no container runs, else SIGTERM first and destroy on a later call", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const idle = fakeContainer();
    expect(await new EyesServer(fakeCtx(idle), {}).stop()).toBe(false);
    expect(idle.signal).not.toHaveBeenCalled();
    expect(idle.destroy).not.toHaveBeenCalled();

    const container = fakeContainer({ running: true });
    const server = new EyesServer(fakeCtx(container), {});

    expect(await server.stop()).toBe(true);
    expect(container.signal).toHaveBeenCalledWith(15);
    expect(container.destroy).not.toHaveBeenCalled();
    expect(await server.stop()).toBe(true);
    expect(container.destroy).toHaveBeenCalledOnce();
    expect(await server.stop()).toBe(false);
    expect(container.signal).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("ensure() does nothing and returns false when the container is already running", async () => {
    const container = fakeContainer({ running: true });
    const dob = new EyesServer(fakeCtx(container), {});

    expect(await dob.ensure()).toBe(false);
    expect(container.start).not.toHaveBeenCalled();
  });

  it("ensure() starts the container with string env vars only, minus ORIGIN", async () => {
    const container = fakeContainer();
    const dob = new EyesServer(fakeCtx(container), {
      ORIGIN: "https://eyes-dispatch.inkboxwire.com",
      INKBOX_API_KEY: "test-key",
      SUBJECT_PREFIX: "",
      EYES: { not: "a string" },
      RETRIES: 3,
    });

    expect(await dob.ensure()).toBe(true);

    expect(container.start).toHaveBeenCalledWith({
      env: { INKBOX_API_KEY: "test-key", SUBJECT_PREFIX: "" },
      enableInternet: true,
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(INACTIVITY_MS);
  });

  it("logs, without throwing, when the container exits with an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let exited: Promise<void> = Promise.resolve();
    const container = fakeContainer({
      monitor: () => {
        exited = Promise.reject(new Error("oom"));
        return exited;
      },
    });
    const dob = new EyesServer(fakeCtx(container), {});

    await dob.ensure();
    // ensure() attached its logger first, so this await runs after the log line.
    await exited.catch(() => {});

    expect(error).toHaveBeenCalledWith(
      "eyes container exited with an error",
      expect.objectContaining({ message: "oom" }),
    );
  });

  describe("fetch() across a boot or a rollout restart", () => {
    // Texts the runtime returned during a live rollout, plus the one @cloudflare/containers matches.
    const REFUSED = "The container is not listening in the TCP address 10.0.0.1:3000";
    const NOT_RUNNING = "The container is not running, consider calling start()";
    const NO_INSTANCE = "there is no container instance that can be provided to this durable object";

    beforeEach(() => {
      vi.useFakeTimers();
    });

    const bodies = (port: FakePort) =>
      port.fetch.mock.calls.map(([, init]) => new TextDecoder().decode(init?.body as ArrayBuffer));

    it("retries after a refused connection and replays the buffered body", async () => {
      const port = fakePort();
      port.fetch
        .mockRejectedValueOnce(new Error(REFUSED))
        .mockRejectedValueOnce(new Error(NO_INSTANCE))
        .mockResolvedValueOnce(new Response("ready", { status: 201 }));
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});

      const pending = dob.fetch(new Request("http://eyes/v1/tasks", { method: "POST", body: "hello" }));
      await vi.advanceTimersByTimeAsync(1_100);
      const res = await pending;

      expect(res.status).toBe(201);
      expect(await res.text()).toBe("ready");
      expect(port.fetch.mock.calls.map(([url]) => url)).toEqual([
        "http://eyes/v1/tasks",
        "http://eyes/v1/tasks",
        "http://eyes/v1/tasks",
      ]);
      expect(bodies(port)).toEqual(["hello", "hello", "hello"]);
    });

    it("answers 503 once the 60 s deadline passes with no answer", async () => {
      const port = fakePort();
      port.fetch.mockRejectedValue(new Error(REFUSED));
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});

      const pending = dob.fetch(new Request("http://eyes/healthz"));
      await vi.advanceTimersByTimeAsync(61_000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect(await res.text()).toBe(`Eyes server unavailable: ${REFUSED}`);
      expect(port.fetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("never replays a request that may have reached the server: 502 at once", async () => {
      const port = fakePort();
      port.fetch.mockRejectedValue(new Error("Network connection lost."));
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});

      const res = await dob.fetch(new Request("http://eyes/v1/tasks", { method: "POST", body: "pay" }));

      expect(res.status).toBe(502);
      expect(await res.text()).toBe("Eyes server unavailable: Network connection lost.");
      expect(port.fetch).toHaveBeenCalledOnce();
    });

    it("holds requests while a rollout swaps the instance and starts the new one when the old exits", async () => {
      const port = fakePort();
      const container = fakeContainer({ port });
      const dob = new EyesServer(fakeCtx(container), {});
      await dob.fetch(new Request("http://eyes/healthz"));
      expect(container.start).toHaveBeenCalledOnce();

      // SIGTERM: the old server stops listening, then exits; the new image answers.
      port.fetch.mockRejectedValueOnce(new Error(REFUSED)).mockImplementationOnce(async () => {
        container.running = false;
        throw new Error(NOT_RUNNING);
      });
      const pending = dob.fetch(
        new Request("http://eyes/mcp", { method: "POST", body: "{}", headers: { "content-length": "2" } }),
      );
      await vi.advanceTimersByTimeAsync(1_100);
      const res = await pending;

      expect(res.status).toBe(200);
      expect(container.start).toHaveBeenCalledTimes(2);
      expect(bodies(port).slice(1)).toEqual(["{}", "{}", "{}"]);
    });

    it("streams a large or unknown-length body once the server is up, without buffering", async () => {
      const port = fakePort();
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});
      await dob.fetch(new Request("http://eyes/healthz"));

      const large = new Request("http://eyes/w/capture", {
        method: "POST",
        body: "x",
        headers: { "content-length": String(1024 * 1024 + 1) },
      });
      await dob.fetch(large);
      const chunked = new Request("http://eyes/w/capture", { method: "POST", body: "x" });
      await dob.fetch(chunked);

      expect(port.fetch.mock.calls[1]?.[0]).toBe(large);
      expect(port.fetch.mock.calls[2]?.[0]).toBe(chunked);
    });

    it("answers a streamed body 503 on refusal and 502 on any other error, without replaying", async () => {
      const port = fakePort();
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});
      await dob.fetch(new Request("http://eyes/healthz"));
      const upload = () => new Request("http://eyes/w/capture", { method: "POST", body: "x" });

      port.fetch.mockRejectedValueOnce(new Error("Network connection lost."));
      expect((await dob.fetch(upload())).status).toBe(502);

      port.fetch.mockRejectedValueOnce(new Error(REFUSED));
      expect((await dob.fetch(upload())).status).toBe(503);
      expect(port.fetch).toHaveBeenCalledTimes(3);

      // The refusal marks the server as restarting, so the next upload is buffered and retried.
      port.fetch.mockRejectedValueOnce(new Error(REFUSED));
      const pending = dob.fetch(upload());
      await vi.advanceTimersByTimeAsync(600);
      expect((await pending).status).toBe(200);
      expect(bodies(port).slice(3)).toEqual(["x", "x"]);
    });
  });
});
