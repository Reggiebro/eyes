import { createHmac, timingSafeEqual } from "node:crypto";
import type { LatLng } from "./schemas.ts";

export const usdToCents = (usd: number): number => Math.round(usd * 100);
export const centsToUsd = (cents: number): number => cents / 100;

const EARTH_RADIUS_M = 6_371_000;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signToken(secret: string, payload: string, expiresAt?: Date): string {
  const body = Buffer.from(JSON.stringify({ p: payload, e: expiresAt?.getTime() ?? null })).toString(
    "base64url",
  );
  return `${body}.${sign(secret, body)}`;
}

export function verifyToken(secret: string, token: string, now = new Date()): string | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const { p, e } = JSON.parse(Buffer.from(body, "base64url").toString()) as { p: string; e: number | null };
  if (e !== null && now.getTime() > e) return null;
  return p;
}
