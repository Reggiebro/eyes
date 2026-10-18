import { describe, expect, it } from "vitest";
import {
  after,
  ago,
  checkReason,
  cut,
  datedQuery,
  eventQuery,
  filterTickets,
  nearLabel,
  nextTab,
  stamp,
  sum,
  tabFor,
  taskHeadline,
  taskSteps,
  ticketOpen,
  time,
  uptime,
  usd,
} from "./format.ts";

describe("ops-view format", () => {
  it("formats money, missing cents as $0.00", () => {
    expect(usd(12345)).toBe("$123.45");
    expect(usd(null)).toBe("$0.00");
    expect(usd(undefined)).toBe("$0.00");
  });

  it("formats times and leaves missing ones blank", () => {
    expect(time("2026-10-17T12:34:00Z")).toMatch(/\d{2}:\d{2}/);
    expect(time(null)).toBe("");
    expect(stamp("2026-10-17T12:34:56Z")).toMatch(/Oct 17.*\d{2}:\d{2}:\d{2}/);
    expect(stamp(undefined)).toBe("");
  });

  it("shows elapsed time in seconds under 90 s, minutes after", () => {
    expect(after("2026-10-17T12:00:00Z", "2026-10-17T12:01:29Z")).toBe("+89s");
    expect(after("2026-10-17T12:00:00Z", "2026-10-17T12:05:00Z")).toBe("+5m");
  });

  it("cuts long text with an ellipsis", () => {
    expect(cut("abcdef", 4)).toBe("abc…");
    expect(cut("abc", 4)).toBe("abc");
    expect(cut(null, 4)).toBe("");
  });

  it("rounds coordinate labels to 3 decimals and keeps named places", () => {
    expect(nearLabel("37.76123456, -122.38598765")).toBe("Near 37.761, -122.386");
    expect(nearLabel(" -33.9,151 ")).toBe("Near -33.900, 151.000");
    expect(nearLabel("Blue Bottle, Mint Plaza")).toBe("Blue Bottle, Mint Plaza");
    expect(nearLabel(null)).toBe("");
  });

  it("marks pre-T6.19 answer checks as old", () => {
    expect(checkReason("Answers the question")).toBe("Old check: Answers the question");
    expect(checkReason("nudity")).toBe("nudity");
  });

  it("sums and formats uptime", () => {
    expect(sum([1, 2, 3])).toBe(6);
    expect(sum([])).toBe(0);
    expect(uptime(125)).toBe("up 2m");
    expect(uptime(3 * 3600 + 5 * 60)).toBe("up 3h 5m");
    expect(uptime(2 * 86400 + 7 * 3600)).toBe("up 2d 7h");
  });

  it("shows ages in the largest whole unit", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(ago("2026-10-17T11:59:30Z", now)).toBe("now");
    expect(ago("2026-10-17T12:00:30Z", now)).toBe("now");
    expect(ago("2026-10-17T11:15:00Z", now)).toBe("45m");
    expect(ago("2026-10-17T03:00:00Z", now)).toBe("9h");
    expect(ago("2026-10-14T12:00:00Z", now)).toBe("3d");
  });

  it("picks the tab from the hash, overview by default", () => {
    expect(tabFor("#review?q=blue&sort=-age")).toBe("review");
    expect(tabFor("#money")).toBe("money");
    expect(tabFor("#nope")).toBe("overview");
    expect(tabFor("")).toBe("overview");
  });

  it("moves between tabs with arrows, Home and End, wrapping around", () => {
    expect(nextTab("tab-overview", "ArrowRight")).toBe("review");
    expect(nextTab("tab-overview", "ArrowLeft")).toBe("access");
    expect(nextTab("tab-access", "ArrowRight")).toBe("overview");
    expect(nextTab("tab-tasks", "Home")).toBe("overview");
    expect(nextTab("tab-tasks", "End")).toBe("access");
    expect(nextTab("tab-tasks", "Enter")).toBeNull();
    expect(nextTab("f-q", "ArrowRight")).toBeNull();
  });

  it("treats disputes as open by dispute status, other tickets by status", () => {
    expect(ticketOpen({ id: 1, kind: "dispute", dispute_status: "open", status: "resolved" })).toBe(true);
    expect(ticketOpen({ id: 1, kind: "dispute", dispute_status: "upheld", status: "open" })).toBe(false);
    expect(ticketOpen({ id: 1, kind: "dispute", dispute_status: null, status: "resolved" })).toBe(true);
    expect(ticketOpen({ id: 1, kind: "help", status: "open" })).toBe(true);
  });

  it("filters tickets by state and a case-insensitive search", () => {
    const tickets = [
      { id: 7, kind: "help", status: "open", question: "Is the cafe open?", message: null },
      { id: 8, kind: "help", status: "resolved", question: "Line length", task_id: "abc-123" },
      { id: 9, kind: "dispute", dispute_status: "open", place_label: "Mint Plaza" },
    ];
    expect(filterTickets(tickets, "", "").map((t) => t.id)).toEqual([7, 8, 9]);
    expect(filterTickets(tickets, "", "open").map((t) => t.id)).toEqual([7, 9]);
    expect(filterTickets(tickets, "", "resolved").map((t) => t.id)).toEqual([8]);
    expect(filterTickets(tickets, "  CAFE ", "").map((t) => t.id)).toEqual([7]);
    expect(filterTickets(tickets, "abc-1", "").map((t) => t.id)).toEqual([8]);
    expect(filterTickets(tickets, "mint", "open").map((t) => t.id)).toEqual([9]);
    expect(filterTickets(tickets, "9", "").map((t) => t.id)).toEqual([9]);
  });

  it("builds event query params from non-empty filters and the paging cursor", () => {
    expect(String(eventQuery({ q: " boom ", kind: "", level: "error", task_id: "" }, null))).toBe(
      "q=boom&level=error",
    );
    expect(String(eventQuery({ q: "", kind: "sms" }, 42))).toBe("kind=sms&before=42");
    expect(String(eventQuery({}, 0))).toBe("");
  });
});

describe("datedQuery", () => {
  const now = new Date(2026, 9, 18, 15, 30);
  const at = (d: number) => new Date(2026, 9, d).toISOString();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  it("turns presets and custom days into a [from, to) window of local days, with the zone", () => {
    expect(datedQuery({ when: "today" }, "", now)).toEqual([
      ["tz", tz],
      ["from", at(18)],
      ["to", at(19)],
    ]);
    expect(datedQuery({ when: "yesterday" }, "", now)).toEqual([
      ["tz", tz],
      ["from", at(17)],
      ["to", at(18)],
    ]);
    expect(datedQuery({ when: "7d" }, "", now)).toEqual([
      ["tz", tz],
      ["from", at(12)],
      ["to", at(19)],
    ]);
    expect(datedQuery({ date_min: "2026-10-10", date_max: "2026-10-11" }, "", now)).toEqual([
      ["tz", tz],
      ["from", at(10)],
      ["to", at(12)],
    ]);
    expect(datedQuery({ date_max: "2026-10-11" }, "", now)).toEqual([
      ["tz", tz],
      ["from", ""],
      ["to", at(12)],
    ]);
  });
  it("sends the zone only with a search or a window, and ignores malformed days", () => {
    expect(datedQuery({}, "", now)).toEqual([
      ["tz", ""],
      ["from", ""],
      ["to", ""],
    ]);
    expect(datedQuery({}, " 18 ", now)).toEqual([
      ["tz", tz],
      ["from", ""],
      ["to", ""],
    ]);
    expect(datedQuery({ date_min: "nope", date_max: "2026-13" }, "", now)).toEqual([
      ["tz", ""],
      ["from", ""],
      ["to", ""],
    ]);
  });
});

describe("task timeline and headline", () => {
  const base = {
    created_at: "2026-10-17T12:00:00Z",
    bounty_cents: 300,
    fee_cents: 60,
    place_label: "Mint Plaza, SF",
  };
  const labels = (t: Parameters<typeof taskSteps>[0]) =>
    taskSteps(t).map((s) => `${s.label}${s.done ? "+" : ""}`);
  it("tells each path: paid, needs review, answer without photo, refunded, expired, disputed", () => {
    expect(labels({ ...base, status: "dispatched" })).toEqual([
      "Asked+",
      "0 notified+",
      "Claimed",
      "Photo",
      "Verified",
      "$3.00 paid",
    ]);
    expect(
      labels({
        ...base,
        status: "needs_review",
        workers_notified: 2,
        claimed_at: "x",
        submitted_at: "y",
        photo_url: "p",
      }),
    ).toEqual(["Asked+", "2 notified+", "Claimed+", "Photo+", "Needs review+", "$3.00 paid"]);
    expect(
      labels({ ...base, status: "verified", claimed_at: "x", submitted_at: "y", money_at: { release: "z" } }),
    ).toEqual(["Asked+", "0 notified+", "Claimed+", "Answer+", "Verified+", "$3.00 paid"]);
    expect(labels({ ...base, status: "refunded", money_at: { refund: "z" } })).toEqual([
      "Asked+",
      "0 notified+",
      "Cancelled+",
      "$3.60 refunded+",
    ]);
    expect(labels({ ...base, status: "expired", claimed_at: "x", money_at: { refund: "z" } })).toEqual([
      "Asked+",
      "0 notified+",
      "Claimed+",
      "Expired+",
      "$3.60 refunded+",
    ]);
    expect(labels({ ...base, status: "disputed", money_at: null }).at(-1)).toBe("Disputed+");
    expect(taskSteps({ created_at: "x", status: "paid" }).at(-1)?.label).toBe("$0.00 paid");
  });
  it("says what a task is doing now, in words", () => {
    const line = (status: string, extra = {}) => taskHeadline({ ...base, status, ...extra });
    expect(line("dispatched", { workers_notified: 1 })).toBe("1 worker notified near Mint Plaza");
    expect(line("dispatched", { workers_notified: 3, place_label: "37.761234, -122.38" })).toBe(
      "3 workers notified near 37.761, -122.380",
    );
    expect(line("dispatched")).toBe("0 workers notified near Mint Plaza");
    expect(line("claimed")).toBe("A worker is on the way to Mint Plaza");
    expect(line("submitted")).toBe("Photo in from Mint Plaza, checking it");
    expect(line("verified")).toBe("Verified at Mint Plaza, paying the worker");
    expect(line("paid")).toBe("Answered at Mint Plaza, worker paid $3.00");
    expect(line("needs_review")).toBe("Answer in from Mint Plaza, it needs a human look");
    expect(line("expired")).toBe("Nobody reached Mint Plaza in time, $3.60 refunded");
    expect(line("refunded")).toBe("Cancelled before anyone claimed it, $3.60 refunded");
    expect(line("disputed")).toBe("The agent disputed the answer from Mint Plaza");
    expect(line("odd_state")).toBe("odd state at Mint Plaza");
    expect(taskHeadline({ created_at: "x", status: "expired" })).toBe(
      "Nobody reached  in time, $0.00 refunded",
    );
  });
});
