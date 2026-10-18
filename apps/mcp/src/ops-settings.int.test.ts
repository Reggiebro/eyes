import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AppConfig, type EyesService, fakeProviders, type SafetyInput, signToken } from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createAssessTask } from "@eyes/safety";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toNodeListener } from "./http.ts";
import { createOpsSettings } from "./ops-settings.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("persisted classifier setting and HTTP boundary", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const settings = createOpsSettings(rpc);
  const providers = fakeProviders();
  const secret = "s".repeat(32);
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: secret,
  });
  const app = createServer({ service: {} as EyesService, providers, config, env: {}, rpc, settings });
  const server = httpServer(toNodeListener(app.fetch));
  let origin = "";
  const cookie = `__Host-eyes_ops=${signToken(secret, "ops:ops@example.com", new Date(providers.clock.now().getTime() + 60_000))}`;
  const headers = {
    cookie,
    "content-type": "application/json",
    origin: "http://internal.eyes.test",
    "x-forwarded-host": "internal.eyes.test",
  };
  const get = () => fetch(`${origin}/api/settings`, { headers });
  const save = (value: unknown, override = {}) =>
    fetch(`${origin}/api/settings`, {
      method: "PUT",
      headers: { ...headers, ...override },
      body: JSON.stringify({ classifier_block_min: value }),
    });
  beforeAll(async () => {
    await migrate(url ?? "");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await sql.end();
  });

  it("serves default, saves, rereads after a fresh store, and records a masked durable audit", async () => {
    expect(await (await get()).json()).toEqual({
      classifier_block_min: 0.95,
      default: 0.95,
      updated_at: null,
      updated_by: null,
    });
    expect(await settings.blockMin()).toBe(0.95);
    const response = await save(0.81);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classifier_block_min: 0.81,
      default: 0.95,
      updated_by: "***@example.com",
    });
    expect(await settings.blockMin()).toBe(0.81);
    expect(await createOpsSettings(rpc).blockMin()).toBe(0.81);
    expect((await (await get()).json()).classifier_block_min).toBe(0.81);
    const [event] =
      await sql`select data from events where data->>'action' = 'classifier_block_min' order by id desc limit 1`;
    expect(event?.data).toEqual({
      action: "classifier_block_min",
      before: 0.95,
      after: 0.81,
      operator: "***@example.com",
    });
  });
  it("refuses anonymous, foreign-origin, missing-origin and invalid writes without changing data", async () => {
    expect((await save(0.5, { cookie: "" })).status).toBe(401);
    expect((await save(0.5, { origin: "http://evil.test" })).status).toBe(403);
    expect((await save(0.5, { origin: "" })).status).toBe(403);
    expect((await save("0.5")).status).toBe(400);
    expect(
      (await fetch(`${origin}/api/settings`, { headers: { "x-forwarded-host": "internal.eyes.test" } }))
        .status,
    ).toBe(401);
    expect((await (await get()).json()).classifier_block_min).toBe(0.81);
    await sql`delete from ops_allowlist where value = 'ops@example.com'`;
    expect((await get()).status).toBe(401);
    await sql`insert into ops_allowlist (kind, value, added_by) values ('email', 'ops@example.com', 'test')`;
  });
  it("enforces SQL boundaries including null/nonfinite and keeps failed transactions atomic", async () => {
    for (const value of [null, 0.49, 1.01, NaN, Infinity, -Infinity]) {
      await expect(sql`select * from eyes_ops_settings_set(${value}, 'test')`).rejects.toThrow();
    }
    await expect(sql`select * from eyes_ops_settings_set(0.9, null)`).rejects.toThrow();
    await expect(sql`select * from eyes_ops_settings_set(0.9, '')`).rejects.toThrow();
    await expect(sql`select * from eyes_ops_settings_set(0.9, ${"x".repeat(201)})`).rejects.toThrow();
    await expect(
      sql.begin(async (tx) => {
        await tx`select * from eyes_ops_settings_set(0.6, '+15555551234')`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await createOpsSettings(rpc).blockMin()).toBe(0.81);
    const [{ count } = { count: -1 }] =
      await sql`select count(*)::int count from events where data->>'after' = '0.6'`;
    expect(count).toBe(0);
    for (const value of [0.5, 1]) expect((await save(value)).status).toBe(200);
  });
  it("serializes concurrent changes with an unbroken audit chain", async () => {
    await Promise.all(
      [0.61, 0.72, 0.83].map((value) =>
        rpc("eyes_ops_settings_set", { p_value: value, p_actor: "+15555551234" }),
      ),
    );
    const events = await sql`select data from events where data->>'operator' = '***1234' order by id`;
    expect(events).toHaveLength(3);
    expect(events[0]?.data.before).toBe(1);
    expect(events[1]?.data.before).toBe(events[0]?.data.after);
    expect(events[2]?.data.before).toBe(events[1]?.data.after);
    expect(await createOpsSettings(rpc).blockMin()).toBe(events[2]?.data.after);
  });
  it("denies table and RPC access to unprivileged database roles", async () => {
    const role = `threshold_test_${randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(`create role ${role}`);
    try {
      const [acl] = await sql`select has_table_privilege(${role}, 'public.ops_settings', 'SELECT') as read,
        has_function_privilege(${role}, 'public.eyes_ops_settings()', 'EXECUTE') as get,
        has_function_privilege(${role}, 'public.eyes_ops_settings_set(double precision,text)', 'EXECUTE') as save`;
      expect(acl).toEqual({ read: false, get: false, save: false });
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select * from public.eyes_ops_settings()`;
        }),
      ).rejects.toThrow(/permission denied/);
      const [rls] =
        await sql`select relrowsecurity from pg_class where oid = 'public.ops_settings'::regclass`;
      expect(rls?.relrowsecurity).toBe(true);
    } finally {
      await sql.unsafe(`drop role ${role}`);
    }
  });
  it("changes real classifier decisions from persisted settings without bypassing rules or failures", async () => {
    const input: SafetyInput = {
      question: "How long is the line at the cafe?",
      task_type: "line_length",
      place_label: "Public cafe",
    };
    const model = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        result: { answers: { verdict: { probabilities: { allowed: 0.3, private_person: 0.7 } } } },
      }),
    );
    const assess = createAssessTask(
      { CLOUDFLARE_ACCOUNT_ID: "test", CLOUDFLARE_API_TOKEN: "test" },
      settings.blockMin,
    );
    try {
      await settings.set(0.95, "integration");
      expect((await assess(input)).allowed).toBe(true);
      await settings.set(0.6, "integration");
      expect(await assess(input)).toMatchObject({
        allowed: false,
        category: "private_person",
        layer: "classifier",
      });
      await settings.set(1, "integration");
      expect(await assess({ ...input, question: "What is the license plate of that car?" })).toMatchObject({
        allowed: false,
        layer: "rules",
      });
      expect(model).toHaveBeenCalledTimes(2);
      model.mockRejectedValueOnce(new Error("provider unavailable"));
      expect((await assess(input)).allowed).toBe(false);
    } finally {
      model.mockRestore();
    }
  });
});
