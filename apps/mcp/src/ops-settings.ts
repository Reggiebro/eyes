import type { Rpc } from "@eyes/db";
import { Hono, type MiddlewareHandler } from "hono";
import type { OpsEnv } from "./ops-auth.ts";

export type OpsSettings = {
  classifier_block_min: number;
  default: number;
  updated_at: string | null;
  updated_by: string | null;
};
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export type OpsSettingsStore = {
  read(): Promise<OpsSettings>;
  set(value: number, actor: string): Promise<OpsSettings>;
  blockMin(): Promise<number>;
};

export function createOpsSettings(rpc: Rpc): OpsSettingsStore {
  let cache: { value: number; until: number } | undefined;
  let revision = 0;
  const read = async () => {
    const [row] = await rpc<OpsSettings>("eyes_ops_settings", {});
    if (
      !row ||
      !Number.isFinite(row.classifier_block_min) ||
      row.classifier_block_min < 0.5 ||
      row.classifier_block_min > 1
    )
      throw new Error("Invalid classifier setting from database");
    return row;
  };
  return {
    read,
    async set(value: number, actor: string) {
      const [row] = await rpc<OpsSettings>("eyes_ops_settings_set", { p_value: value, p_actor: actor });
      if (!row) throw new Error("Classifier setting was not saved");
      revision++;
      cache = undefined;
      return row;
    },
    async blockMin() {
      if (cache && cache.until > Date.now()) return cache.value;
      const version = revision;
      const row = await read();
      if (version === revision) cache = { value: row.classifier_block_min, until: Date.now() + 15_000 };
      return row.classifier_block_min;
    },
  };
}

export function opsSettingsRoutes(
  settings: OpsSettingsStore,
  operator: MiddlewareHandler<OpsEnv>,
  sameOrigin: MiddlewareHandler,
) {
  const routes = new Hono<OpsEnv>();
  routes.get("/ops/api/settings", operator, async (c) => c.json(await settings.read(), 200, HEADERS));
  routes.put("/ops/api/settings", operator, sameOrigin, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const value =
      body && typeof body === "object" && "classifier_block_min" in body
        ? body.classifier_block_min
        : undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.5 || value > 1)
      return c.json(
        { error: "invalid_input", message: "classifier_block_min must be a finite number from 0.5 to 1." },
        400,
        HEADERS,
      );
    return c.json(await settings.set(value, c.get("operator").label), 200, HEADERS);
  });
  return routes;
}
