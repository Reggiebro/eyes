import { AppConfig, fakeProviders, signToken } from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opsAuth } from "./ops-auth.ts";
import { createOpsSettings, type OpsSettings, opsSettingsRoutes } from "./ops-settings.ts";

const row = (value = 0.95): OpsSettings => ({
  classifier_block_min: value,
  default: 0.95,
  updated_at: null,
  updated_by: null,
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const saved = row();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "eyes_ops_allowlist") return [{ id: "operator", value: "private@example.com" }];
    if (name === "eyes_ops_settings_set")
      Object.assign(saved, row(Number(args.p_value)), { updated_by: args.p_actor });
    return [{ ...saved }];
  });
  const settings = createOpsSettings(rpc as Rpc);
  const providers = fakeProviders();
  const config = AppConfig.parse({
    public_api_url: "http://localhost",
    worker_web_url: "http://localhost",
    link_secret: "s".repeat(32),
  });
  const ops = opsAuth({
    rpc: rpc as Rpc,
    providers,
    config,
    env: {},
    log: () => {},
    site: () => ({ base: "/ops", origin: "http://localhost" }),
  });
  const app = new Hono().route("/", opsSettingsRoutes(settings, ops.operator, ops.sameOrigin));
  const cookie = `__Host-eyes_ops=${signToken(config.link_secret, "ops:private@example.com", new Date(providers.clock.now().getTime() + 60_000))}`;
  const put = (body: string, headers: Record<string, string> = {}) =>
    app.request("/ops/api/settings", {
      method: "PUT",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json", ...headers },
      body,
    });
  return { rpc, settings, app, cookie, put, saved };
}

describe("ops settings boundary", () => {
  it("requires an allowlisted session and the existing same-origin CSRF protection", async () => {
    const { app, put, rpc } = fixture();
    expect((await app.request("/ops/api/settings")).status).toBe(401);
    expect((await put('{"classifier_block_min":0.8}', { cookie: "" })).status).toBe(401);
    expect((await put('{"classifier_block_min":0.8}', { origin: "https://evil.test" })).status).toBe(403);
    expect((await put('{"classifier_block_min":0.8}', { origin: "" })).status).toBe(403);
    expect(rpc.mock.calls.some(([name]) => name === "eyes_ops_settings_set")).toBe(false);
  });
  it.each([
    "{",
    "null",
    "[]",
    "{}",
    '"text"',
    '{"classifier_block_min":"0.9"}',
    '{"classifier_block_min":null}',
    '{"classifier_block_min":0.49}',
    '{"classifier_block_min":1.01}',
    '{"classifier_block_min":1e400}',
  ])("rejects invalid JSON/value %s", async (body) => {
    const { put, rpc } = fixture();
    expect((await put(body)).status).toBe(400);
    expect(rpc.mock.calls.some(([name]) => name === "eyes_ops_settings_set")).toBe(false);
  });
  it.each([0.5, 0.95, 1])(
    "saves inclusive boundary %s with a masked actor, returning the fixed contract",
    async (value) => {
      const { put, app, cookie, rpc } = fixture();
      const response = await put(JSON.stringify({ classifier_block_min: value }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ...row(value), updated_by: "***@example.com" });
      expect(rpc).toHaveBeenCalledWith("eyes_ops_settings_set", {
        p_value: value,
        p_actor: "***@example.com",
      });
      expect(await (await app.request("/ops/api/settings", { headers: { cookie } })).json()).toEqual({
        ...row(value),
        updated_by: "***@example.com",
      });
    },
  );
});

describe("classifier setting cache", () => {
  it("caches for 15 seconds and invalidates immediately after a local save", async () => {
    const { settings, rpc, saved } = fixture();
    const time = vi.spyOn(Date, "now").mockReturnValue(1000);
    expect(await settings.blockMin()).toBe(0.95);
    saved.classifier_block_min = 0.7;
    expect(await settings.blockMin()).toBe(0.95);
    time.mockReturnValue(16_000);
    expect(await settings.blockMin()).toBe(0.7);
    await settings.set(0.8, "***@example.com");
    expect(await settings.blockMin()).toBe(0.8);
    expect(rpc.mock.calls.filter(([name]) => name === "eyes_ops_settings")).toHaveLength(3);
  });
  it("does not let an in-flight old read repopulate an invalidated cache", async () => {
    let release = (_rows: OpsSettings[]) => {};
    const rpc = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<OpsSettings[]>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce([row(0.8)])
      .mockResolvedValueOnce([row(0.8)]);
    const settings = createOpsSettings(rpc as Rpc);
    const old = settings.blockMin();
    await settings.set(0.8, "operator");
    release([row(0.95)]);
    await old;
    expect(await settings.blockMin()).toBe(0.8);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it.each([[], [row(NaN)], [row(Infinity)], [row(0.4)], [row(1.1)]].map((rows) => ({ rows })))(
    "fails closed on missing or invalid persisted values $rows",
    async ({ rows }) => {
      const settings = createOpsSettings(vi.fn().mockResolvedValue(rows) as Rpc);
      await expect(settings.blockMin()).rejects.toThrow("Invalid classifier setting");
    },
  );
  it("propagates database errors without caching and refuses an empty save result", async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([]);
    const settings = createOpsSettings(rpc as Rpc);
    await expect(settings.blockMin()).rejects.toThrow("offline");
    expect(await settings.blockMin()).toBe(0.95);
    await expect(settings.set(0.8, "operator")).rejects.toThrow("not saved");
    expect(await settings.blockMin()).toBe(0.95);
  });
});
