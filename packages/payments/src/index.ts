import { EyesError, type Payments, type RouteDeps } from "@eyes/core";
import { Hono } from "hono";

type Env = Record<string, string | undefined>;

export function createStripePayments(_env: Env): Payments {
  throw new EyesError("not_implemented", { task: "T2.1" });
}

export function stripeRoutes(_deps: RouteDeps, _env: Env): Hono {
  return new Hono().all("*", (c) => c.json(new EyesError("not_implemented").toBody(), 501));
}
