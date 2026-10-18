// Pure helpers for the /ops page. server.ts inlines this file (types stripped) into ops.html.
export const POLL_MS = 10000;
export const STATUS_TONE: Record<string, string> = {
  dispatched: "accent",
  claimed: "accent",
  submitted: "accent",
  verified: "success",
  paid: "success",
  needs_review: "danger",
  disputed: "danger",
  expired: "",
  refunded: "",
};
export const LIVE = ["dispatched", "claimed", "submitted"];
export const LEDGER_LABEL: Record<string, string> = {
  topup: "Top-up",
  escrow: "Escrow",
  release: "Release",
  refund: "Refund",
  payout: "Payout",
  fee: "Fee",
};
export const TABS = ["overview", "review", "support", "tasks", "workers", "money", "logs", "access"];

export const usd = (cents: number | null | undefined) => `$${((cents || 0) / 100).toFixed(2)}`;
export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
export const stamp = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";
export const after = (from: string, to: string) => {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s < 90 ? `+${s}s` : `+${Math.round(s / 60)}m`;
};
export const cut = (text: string | null | undefined, n: number) =>
  text && text.length > n ? `${text.slice(0, n - 1)}…` : text || "";
// Coordinates as a place label: rounded like the worker pages (about 100 m), never full precision.
const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
export const nearLabel = (label: string | null | undefined) => {
  const m = COORDS.exec(label || "");
  return m ? `Near ${Number(m[1]).toFixed(3)}, ${Number(m[2]).toFixed(3)}` : label || "";
};
// Before T6.19 the photo check judged the answer; those old reasons are not moderation verdicts.
export const checkReason = (r: string) => (/answers? the question/i.test(r) ? `Old check: ${r}` : r);
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Age as "now", "5m", "3h" or "2d". */
export function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function uptime(s: number) {
  if (s < 3600) return `up ${Math.floor(s / 60)}m`;
  if (s < 86400) return `up ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `up ${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// Tabs: the URL hash picks one (#review, #support, ...) so reloads and links keep it.
// A tab's hash may carry its table state after a "?": #review?sort=-age.
export function tabFor(hash: string) {
  const tab = hash.slice(1).split("?")[0] ?? "";
  return TABS.includes(tab) ? tab : "overview";
}
// Arrow keys, Home and End move between tabs; null when the key or focus is not a tab move.
export function nextTab(focusedId: string, key: string) {
  const i = TABS.indexOf(focusedId.replace("tab-", ""));
  const next = (
    { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>
  )[key];
  if (i < 0 || next === undefined) return null;
  return TABS[(next + TABS.length) % TABS.length] as string;
}

// Ticket search: open/resolved filter, then a case-insensitive match on id, question, message, task, place.
export type TicketFields = {
  id: number;
  kind?: string;
  status?: string;
  dispute_status?: string | null;
  question?: string | null;
  message?: string | null;
  task_id?: string | null;
  place_label?: string | null;
};
// A dispute with no dispute_status yet counts as open, like its badge says.
export const ticketOpen = (t: TicketFields) =>
  t.kind === "dispute" ? (t.dispute_status ?? "open") === "open" : t.status === "open";
export function filterTickets<T extends TicketFields>(tickets: T[], query: string, status: string) {
  const q = query.trim().toLowerCase();
  return tickets.filter(
    (t) =>
      (!status || (status === "open") === ticketOpen(t)) &&
      (!q ||
        [t.id, t.question, t.message, t.task_id, t.place_label].some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(q),
        )),
  );
}

/** Date presets for the server-paged lists; "Custom" is the from/to day inputs next to it. */
export const WHEN: [string, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
];
/**
 * The date filters as query params for the API: the browser's time zone (so search `q` matches dates
 * as shown) and a [from, to) window from a preset (`when`) or the custom days (`date_min`, `date_max`,
 * both inclusive), in local days.
 */
export function datedQuery(f: Record<string, string>, q: string, now: Date): [string, string][] {
  const day = (offset: number, base = now) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  const local = (text: string) => {
    const [y, m, d] = text.split("-").map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let from: Date | null = null;
  let to: Date | null = null;
  if (f.when === "today") [from, to] = [day(0), day(1)];
  else if (f.when === "yesterday") [from, to] = [day(-1), day(0)];
  else if (f.when === "7d") [from, to] = [day(-6), day(1)];
  else {
    from = f.date_min ? local(f.date_min) : null;
    const last = f.date_max ? local(f.date_max) : null;
    to = last && day(1, last);
  }
  return [
    // The zone matters only to a search or a window; without one the URL stays short.
    ["tz", q.trim() || from || to ? tz : ""],
    ["from", from?.toISOString() ?? ""],
    ["to", to?.toISOString() ?? ""],
  ];
}

// Event log filters as query params; `before` pages back from the oldest row shown.
export function eventQuery(fields: Record<string, string>, before: number | null) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    const v = value.trim();
    if (v) p.set(key, v);
  }
  if (before) p.set("before", String(before));
  return p;
}

/** What a task timeline needs; the feed, the Tasks list and the worker panel all carry these. */
export type Timed = {
  status: string;
  created_at: string;
  claimed_at?: string | null;
  submitted_at?: string | null;
  photo_url?: string | null;
  workers_notified?: number | null;
  bounty_cents?: number;
  fee_cents?: number;
  money_at?: Record<string, string> | null;
  place_label?: string | null;
};
export type Step = { label: string; at: string | null; done: boolean; tone: string };

/** The live map's timeline: Asked, N notified, Claimed, Photo, Verified, $ paid; or the refund. */
export function taskSteps(t: Timed): Step[] {
  const m = t.money_at ?? {};
  const total = usd((t.bounty_cents ?? 0) + (t.fee_cents ?? 0));
  const list: Omit<Step, "done">[] = [
    { label: "Asked", at: t.created_at, tone: "accent" },
    { label: `${t.workers_notified ?? 0} notified`, at: t.created_at, tone: "accent" },
  ];
  if (t.claimed_at || !m.refund) list.push({ label: "Claimed", at: t.claimed_at ?? null, tone: "accent" });
  if (m.refund) {
    list.push({ label: t.status === "expired" ? "Expired" : "Cancelled", at: m.refund, tone: "muted" });
    list.push({ label: `${total} refunded`, at: m.refund, tone: "muted" });
  } else {
    list.push({
      label: t.submitted_at && !t.photo_url ? "Answer" : "Photo",
      at: t.submitted_at ?? null,
      tone: "accent",
    });
    if (t.status === "needs_review")
      list.push({ label: "Needs review", at: t.submitted_at ?? null, tone: "warning" });
    else list.push({ label: "Verified", at: m.release ?? null, tone: "success" });
    list.push({ label: `${usd(t.bounty_cents)} paid`, at: m.payout ?? null, tone: "success" });
  }
  const steps = list.map((s) => ({ ...s, done: Boolean(s.at) }));
  if (t.status === "disputed") steps.push({ label: "Disputed", at: null, done: true, tone: "danger" });
  return steps;
}

/** One line on what a task is doing now, as the live map said it. */
export function taskHeadline(t: Timed) {
  // "Near 37.761, -122.386" keeps both numbers; a named place keeps its first part.
  const near = nearLabel(t.place_label);
  const place = near.startsWith("Near ") ? near.slice(5) : near.split(",")[0];
  const n = t.workers_notified ?? 0;
  const total = usd((t.bounty_cents ?? 0) + (t.fee_cents ?? 0));
  const lines: Record<string, string> = {
    dispatched: `${n} ${n === 1 ? "worker" : "workers"} notified near ${place}`,
    claimed: `A worker is on the way to ${place}`,
    submitted: `Photo in from ${place}, checking it`,
    verified: `Verified at ${place}, paying the worker`,
    paid: `Answered at ${place}, worker paid ${usd(t.bounty_cents)}`,
    needs_review: `Answer in from ${place}, it needs a human look`,
    expired: `Nobody reached ${place} in time, ${total} refunded`,
    refunded: `Cancelled before anyone claimed it, ${total} refunded`,
    disputed: `The agent disputed the answer from ${place}`,
  };
  return lines[t.status] ?? `${statusWords(t.status)} at ${place}`;
}
const statusWords = (s: string) => s.replace(/_/g, " ");
