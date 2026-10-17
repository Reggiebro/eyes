import { type Email, EyesError, type Messaging, type RouteDeps } from "@eyes/core";
import { Hono } from "hono";

type Env = Record<string, string | undefined>;

export function createInkboxMessaging(_env: Env): Messaging {
  throw new EyesError("not_implemented", { task: "T1.3" });
}

export function createPrimitiveEmail(_env: Env): Email {
  throw new EyesError("not_implemented", { task: "T3.1" });
}

export function inkboxRoutes(_deps: RouteDeps, _env: Env): Hono {
  return new Hono().post("/", (c) => c.json(new EyesError("not_implemented").toBody(), 501));
}

export function primitiveRoutes(_deps: RouteDeps, _env: Env): Hono {
  return new Hono().post("/", (c) => c.json(new EyesError("not_implemented").toBody(), 501));
}
