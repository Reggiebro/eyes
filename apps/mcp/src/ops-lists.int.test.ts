import { randomUUID } from "node:crypto";
import { createRpc, migrate } from "@eyes/db";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsEnv } from "./ops-auth.ts";
import { opsLists } from "./ops-lists.ts";

const url = process.env.DATABASE_URL;
const pass: MiddlewareHandler<OpsEnv> = async (_c, next) => next();

describe.skipIf(!url)("ops lists on Postgres (keyset paging)", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const app = opsLists({ rpc: createRpc({ kind: "postgres", url: url ?? "" }), operator: pass });
  // Every row this test makes carries the marker, and every query searches for it, so other rows
  // in the shared database never show up.
  // No 17 or 18 in it: the shown-only search cases below must not hit the marker.
  const marker = `pg${randomUUID()
    .slice(0, 8)
    .replace(/1(?=[78])/g, "a")}`;
  const AT = "2026-10-17T12:00:00.123456+00:00";
  // Only this test's rows: a microsecond-wide window around AT (the ledger shows no marker to search).
  const AT_WINDOW = "from=2026-10-17T12:00:00.123Z&to=2026-10-17T12:00:00.124Z";
  // Task ids whose shown 8-char prefix has no 17 or 18, so the search cases below cannot hit them.
  const taskId = (): string => {
    const id = randomUUID();
    return /1[78]/.test(id.slice(0, 8)) ? taskId() : id;
  };
  const get = async (path: string) => (await app.request(path)).json();

  async function all(path: string, key: string) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const body = await get(`${path}${cursor ? `&cursor=${cursor}` : ""}`);
      ids.push(...body[key].map((r: { id: string | number }) => String(r.id)));
      cursor = body.next_cursor;
      if (!cursor) return { ids, total: body.total };
    }
    throw new Error("paging did not end");
  }

  let agent = "";
  let worker = "";
  const tasks: string[] = [];
  beforeAll(async () => {
    await migrate(url ?? "");
    [{ id: agent }] =
      (await sql`insert into agents (name, api_key_hash) values (${`bot ${marker}`}, ${marker})
      returning id`) as unknown as [{ id: string }];
    [{ id: worker }] = (await sql`insert into workers (phone, name, lat, lng, opted_in)
      values (${`+1555${Date.now() % 10_000_000}`}, ${marker}, 37.78, -122.4, true) returning id`) as unknown as [
      { id: string },
    ];
    // Seven of each, all at the same instant: only the id breaks ties.
    for (let i = 0; i < 7; i++) {
      const [task] =
        await sql`insert into tasks (id, agent_id, question, task_type, place_label, lat, lng, bounty_cents,
          fee_cents, deadline_at, status, created_at)
        values (${taskId()}, ${agent}, ${`q${i} ${marker}`}, 'is_open', 'Mint Plaza', 37.78, -122.4, ${100 + i}, 50,
          now() + interval '1 hour', ${i % 2 ? "paid" : "needs_review"}, ${AT}) returning id`;
      tasks.push(task?.id);
      await sql`insert into ledger (agent_id, task_id, type, amount_cents, created_at)
        values (${agent}, ${task?.id}, 'escrow', ${150 + i}, ${AT})`;
      await sql`insert into tickets (worker_id, task_id, kind, status, message, created_at, resolved_at)
        values (${worker}, ${task?.id}, 'manual_review', ${i < 3 ? "open" : "resolved"}, ${`help ${marker}`}, ${AT},
          ${i < 3 ? null : AT})`;
      await sql`insert into events (at, kind, level, summary) values (${AT}, 'http', ${i === 0 ? "error" : "info"},
        ${`e${i} ${marker}`})`;
    }
  });
  afterAll(async () => {
    await sql`delete from submissions where worker_id = ${worker}`;
    await sql`delete from events where summary like ${`%${marker}`}`;
    await sql`delete from tickets where worker_id = ${worker}`;
    await sql`delete from ledger where agent_id = ${agent} or worker_id = ${worker}`;
    await sql`delete from tasks where agent_id = ${agent}`;
    await sql`delete from workers where id = ${worker}`;
    await sql`delete from agents where id = ${agent}`;
    await sql.end();
  });

  it("pages events with equal timestamps without skipping or repeating, newest id first", async () => {
    const { ids } = await all(`/ops/events?limit=3&q=${marker}`, "events");
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toEqual([...ids].sort((a, b) => Number(b) - Number(a)));
    const errors = await all(`/ops/events?limit=3&q=${marker}&level=error`, "events");
    expect(errors.ids).toHaveLength(1);
  });

  it("returns only newer events after a since cursor", async () => {
    const first = await get(`/ops/events?q=${marker}`);
    expect((await get(`/ops/events?q=${marker}&since=${first.newest_cursor}`)).events).toEqual([]);
    await sql`insert into events (at, kind, level, summary) values (${AT}, 'http', 'info', ${`late ${marker}`})`;
    const fresh = await get(`/ops/events?q=${marker}&since=${first.newest_cursor}`);
    expect(fresh.events.map((e: { summary: string }) => e.summary)).toEqual([`late ${marker}`]);
    expect(fresh.newest_cursor).not.toBe(first.newest_cursor);
  });

  it("pages tickets, tasks and the ledger the same way, with filters and the filtered sum", async () => {
    const tickets = await all(`/ops/tickets?limit=2&q=${marker}`, "tickets");
    expect([tickets.total, new Set(tickets.ids).size]).toEqual([7, 7]);
    expect((await all(`/ops/tickets?limit=2&q=${marker}&state=open`, "tickets")).ids).toHaveLength(3);
    expect((await all(`/ops/tickets?limit=2&q=${marker}&state=resolved`, "tickets")).ids).toHaveLength(4);

    const found = await all(`/ops/tasks?limit=3&q=${marker}`, "tasks");
    expect([found.total, new Set(found.ids).size]).toEqual([7, 7]);
    expect(new Set(found.ids)).toEqual(new Set(tasks));
    expect((await all(`/ops/tasks?limit=3&q=${marker}&status=paid`, "tasks")).ids).toHaveLength(3);
    const task = (await get(`/ops/tasks?limit=1&q=${marker}`)).tasks[0];
    expect(task).toMatchObject({ agent: `bot ${marker}`, distance_m: null, workers_notified: 0 });

    const ledger = await all(`/ops/ledger?limit=4&${AT_WINDOW}`, "ledger");
    expect([ledger.total, new Set(ledger.ids).size]).toEqual([7, 7]);
    const sum = await get(`/ops/ledger?limit=1&${AT_WINDOW}&type=escrow`);
    expect(sum.total_cents).toBe(150 * 7 + 21);
    expect(sum.ledger[0]).toMatchObject({ type: "escrow", place_label: "Mint Plaza" });
  });

  it("searches only what a row shows: the date in the browser's zone, labels, amounts and short ids", async () => {
    const count = async (path: string) => (await get(path)).total;
    // Everything is Oct 17 (amounts $1.50 to $1.56, ids without 17 or 18): "18" shows nowhere.
    expect(await count(`/ops/ledger?q=18&tz=UTC&${AT_WINDOW}`)).toBe(0);
    expect(await count(`/ops/ledger?q=Oct%2017&tz=UTC&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/ledger?q=17&tz=UTC&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/ledger?q=%241.53&tz=UTC&${AT_WINDOW}`)).toBe(1);
    expect(await count(`/ops/ledger?q=escrow&${AT_WINDOW}`)).toBe(7);
    // Noon UTC is 05:00 AM in Los Angeles: the date matches as that browser shows it.
    expect(await count(`/ops/ledger?q=05%3A00%3A00%20AM&tz=America%2FLos_Angeles&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/ledger?q=05%3A00%3A00%20AM&tz=Not%2FAZone&${AT_WINDOW}`)).toBe(0);
    const id = tasks[3] as string;
    expect((await get(`/ops/tasks?q=${id.slice(0, 8)}`)).tasks.map((t: { id: string }) => t.id)).toEqual([
      id,
    ]);
    // The full id is not shown, so it does not match.
    expect(await count(`/ops/tasks?q=${id}`)).toBe(0);
    expect(await count(`/ops/tasks?q=Oct%2017&tz=UTC&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/tasks?q=18&tz=UTC&${AT_WINDOW}`)).toBe(0);
    expect((await all(`/ops/events?q=18&tz=UTC&${AT_WINDOW}`, "events")).ids).toEqual([]);
    expect(
      (await all(`/ops/events?q=Oct%2017&tz=UTC&${AT_WINDOW}`, "events")).ids.length,
    ).toBeGreaterThanOrEqual(7);
  });

  it("reads one worker for the Workers panel: their tasks newest first, the latest photo checks, and earnings", async () => {
    const rpc = createRpc({ kind: "postgres", url: url ?? "" });
    const [a, b] = tasks as [string, string];
    await sql`update tasks set claimed_by = ${worker}, claimed_at = ${AT} where id = ${a}`;
    await sql`insert into submissions (task_id, worker_id, photo_url, lat, lng, captured_at, gps_ok, fresh_ok, vision_ok,
      vision_reason, confidence, source, created_at)
      values (${b}, ${worker}, 'https://storage.eyes.test/p.jpg', 37.78, -122.4, ${AT}, true, true, false, 'blurry', 0.7,
        'capture', ${AT})`;
    await sql`insert into ledger (agent_id, worker_id, task_id, type, amount_cents, created_at)
      values (${agent}, ${worker}, ${b}, 'release', 300, ${AT}), (null, ${worker}, ${b}, 'payout', 300, ${AT})`;
    const [row] = await rpc<{
      worker: Record<string, unknown>;
      tasks: Record<string, unknown>[];
      earnings: Record<string, unknown>;
    }>("eyes_ops_worker", { p_id: worker, p_limit: 10 });
    expect(row?.worker).toMatchObject({ id: worker, available: true, opted_in: true, banned: false });
    expect(row?.worker).not.toHaveProperty("phone");
    expect(row?.worker).not.toHaveProperty("name");
    expect(new Set(row?.tasks.map((t) => t.id))).toEqual(new Set([a, b]));
    const shot = row?.tasks.find((t) => t.id === b);
    expect(shot).toMatchObject({
      photo_url: "https://storage.eyes.test/p.jpg",
      gps_ok: true,
      vision_ok: false,
      confidence: 0.7,
    });
    expect(shot?.money_at).toHaveProperty("payout");
    expect(row?.earnings).toMatchObject({ paid_cents: 300, payouts: 1, released_cents: 300 });
    const [none] = await rpc<{ worker: unknown; tasks: unknown[] }>("eyes_ops_worker", {
      p_id: randomUUID(),
      p_limit: 10,
    });
    expect([none?.worker, none?.tasks]).toEqual([null, []]);
  });
});

describe.skipIf(!url)("ops map tasks on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const marker = `map${randomUUID().slice(0, 8)}`;
  let agent = "";
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    await migrate(url ?? "");
    [{ id: agent }] =
      (await sql`insert into agents (name, api_key_hash) values (${marker}, ${marker}) returning id`) as unknown as [
        { id: string },
      ];
    // An old needs-review task, an old paid one, a fresh paid one, all at the same spot.
    for (const [name, status, hours] of [
      ["oldReview", "needs_review", 30],
      ["oldPaid", "paid", 30],
      ["freshPaid", "paid", 2],
    ] as const) {
      const [t] =
        await sql`insert into tasks (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents,
          deadline_at, status, created_at)
        values (${agent}, ${`${name} ${marker}`}, 'is_open', 'Near 37.761, -122.386', 37.761, -122.386, 300, 50,
          now() + interval '1 hour', ${status}, now() - ${`${hours} hours`}::interval) returning id`;
      ids[name] = t?.id;
    }
  });
  afterAll(async () => {
    await sql`delete from tasks where agent_id = ${agent}`;
    await sql`delete from agents where id = ${agent}`;
    await sql.end();
  });
  const mine = async (args: Record<string, unknown>) =>
    (
      await rpc<{ id: string }>("eyes_map_tasks", {
        p_status: null,
        p_from: null,
        p_to: null,
        p_now: new Date().toISOString(),
        ...args,
      })
    )
      .map((t) => t.id)
      .filter((id) => Object.values(ids).includes(id))
      .sort();

  it("keeps a needs-review task older than 24 h on the map, with the last 24 h of the rest", async () => {
    expect(await mine({})).toEqual([ids.oldReview, ids.freshPaid].sort());
    expect(await mine({ p_status: "paid" })).toEqual([ids.freshPaid]);
    expect(
      await mine({
        p_from: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        p_to: new Date(Date.now() - 24 * 3_600_000).toISOString(),
      }),
    ).toEqual([ids.oldReview, ids.oldPaid].sort());
  });
});

describe.skipIf(!url)("ops issues on Postgres (grouping, status, regression)", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const fp = randomUUID().replace(/-/g, "").slice(0, 16);
  const occ = (at: string, tags: Record<string, string> = {}) => ({
    fingerprint: fp,
    level: "warn",
    title: "clef slow: <n> ms",
    culprit: null,
    message: `clef slow: ${at.slice(11, 13)} ms`,
    stack: null,
    at,
    tags,
  });
  type Issue = {
    status: string;
    regressed: boolean;
    count: number;
    ignore_until: number | null;
    level: string;
  };
  const issue = async () => {
    const [row] = await sql<
      Issue[]
    >`select status, regressed, count, ignore_until, level from ops_issues where fingerprint = ${fp}`;
    return row;
  };
  beforeAll(() => migrate(url ?? ""));
  afterAll(async () => {
    await sql`delete from ops_issues where fingerprint = ${fp}`;
    await sql.end();
  });

  it("groups occurrences, counts who they touched, sparks the last 24 hours, and reopens resolved issues as regressed", async () => {
    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    await rpc("eyes_issues_record", {
      p_events: [
        occ(hoursAgo(30)),
        occ(hoursAgo(2), { worker_id: "w1", task_id: "t1" }),
        occ(hoursAgo(1), { worker_id: "w2" }),
      ],
    });
    expect(await issue()).toMatchObject({ status: "unresolved", regressed: false, count: 3, level: "warn" });
    const rows = await rpc<{ fingerprint: string; spark: number[]; affected: Record<string, number> }>(
      "eyes_issues",
      {
        p_now: now.toISOString(),
      },
    );
    const mine = rows.find((r) => r.fingerprint === fp);
    expect(mine?.spark).toHaveLength(24);
    expect(mine?.spark.reduce((a, b) => a + b, 0)).toBe(2);
    expect(mine?.affected).toEqual({ workers: 2, agents: 0, tasks: 1 });
    const latest = await rpc<{ at: string }>("eyes_issue_events", { p_fingerprint: fp, p_limit: 2 });
    expect(latest.map((e) => e.at)).toHaveLength(2);

    await rpc("eyes_issue_status", {
      p_fingerprint: fp,
      p_status: "resolved",
      p_more: null,
      p_by: "op",
      p_now: now.toISOString(),
    });
    expect(await issue()).toMatchObject({ status: "resolved" });
    await rpc("eyes_issues_record", { p_events: [{ ...occ(now.toISOString()), level: "error" }] });
    expect(await issue()).toMatchObject({ status: "unresolved", regressed: true, count: 4, level: "error" });
  });

  it("ignores until N more occurrences, or forever, and reopening clears the ignore", async () => {
    const at = new Date().toISOString();
    await rpc("eyes_issue_status", {
      p_fingerprint: fp,
      p_status: "ignored",
      p_more: 2,
      p_by: "op",
      p_now: at,
    });
    expect(await issue()).toMatchObject({ status: "ignored", ignore_until: 6, regressed: false });
    await rpc("eyes_issues_record", { p_events: [occ(at)] });
    expect(await issue()).toMatchObject({ status: "ignored", count: 5 });
    await rpc("eyes_issues_record", { p_events: [occ(at)] });
    expect(await issue()).toMatchObject({ status: "unresolved", count: 6, ignore_until: null });
    await rpc("eyes_issue_status", {
      p_fingerprint: fp,
      p_status: "ignored",
      p_more: null,
      p_by: "op",
      p_now: at,
    });
    await rpc("eyes_issues_record", { p_events: [occ(at), occ(at), occ(at)] });
    expect(await issue()).toMatchObject({ status: "ignored", ignore_until: null, count: 9 });
    const [reopened] = await rpc<{ status: string }>("eyes_issue_status", {
      p_fingerprint: fp,
      p_status: "unresolved",
      p_more: null,
      p_by: "op",
      p_now: at,
    });
    expect(reopened?.status).toBe("unresolved");
    expect(
      await rpc("eyes_issue_status", {
        p_fingerprint: "nope",
        p_status: "resolved",
        p_more: null,
        p_by: "op",
        p_now: at,
      }),
    ).toEqual([]);
  });
});
