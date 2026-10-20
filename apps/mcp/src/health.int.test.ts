import { AppConfig, fakeProviders } from "@eyes/core";
import { migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("health check on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = fakeProviders();
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://w.eyes.test",
    link_secret: "test-link-secret-0123456789",
  });
  const service = createEyesService({
    db: { kind: "postgres", url: url ?? "" },
    config,
    providers,
    assessTask: async () => {
      throw new Error("Health checks must not assess tasks");
    },
    verifySubmission: async () => {
      throw new Error("Health checks must not verify submissions");
    },
  });
  const server = createServer({ service, config, providers, env: { DATABASE_URL: url } });
  const health = () => server.fetch(new Request("http://api.eyes.test/healthz"));

  beforeAll(() => migrate(url ?? ""), 60_000);
  afterAll(() => sql.end());

  it("reports a healthy empty database without inserting an agent", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, db: "postgres" });
    expect(await sql`select count(*)::int as count from agents`).toEqual([{ count: 0 }]);
  });

  it("reports a failed database read without exposing its error", async () => {
    await sql`alter function eyes_agent_by_key_hash(text) rename to unavailable_agent_lookup`;
    try {
      const response = await health();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false });
    } finally {
      await sql`alter function unavailable_agent_lookup(text) rename to eyes_agent_by_key_hash`;
    }
    expect((await health()).status).toBe(200);
  });

  it("answers while a database lock blocks the read", async () => {
    await sql.begin(async (tx) => {
      await tx`lock table agents in access exclusive mode`;
      const response = await health();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false });
    });
    expect((await health()).status).toBe(200);
  }, 15_000);
});
