import { randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createRpc } from "./rpc.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("temporary dispute review holds on isolated Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const now = new Date().toISOString();
  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  async function fixture() {
    const [agent] = await sql`insert into agents (name, api_key_hash, balance_cents)
      values ('policy-proof', ${randomUUID()}, 10000) returning id`;
    const [worker] = await sql`insert into workers (name, phone, lat, lng, opted_in, available)
      values ('policy-proof', ${`+1555${String(randomInt(10_000_000)).padStart(7, "0")}`},
        37.77, -122.4, true, true) returning id`;
    const agentId = String(agent?.id);
    const workerId = String(worker?.id);
    async function task(test = false, status = "verified") {
      const claimed = status !== "dispatched";
      const [row] = await sql`insert into tasks (agent_id, question, task_type, place_label, lat, lng,
        radius_m, bounty_cents, fee_cents, deadline_at, status, claimed_by, claimed_at, test)
        values (${agentId}, 'Is the shop open?', 'is_open', 'Shop', 37.77, -122.4, 150, 300, 50,
          now() + interval '1 hour', ${status}, ${claimed ? workerId : null},
          ${claimed ? now : null}, ${test}) returning id`;
      return String(row?.id);
    }
    const dispute = (taskId: string) => rpc("eyes_dispute", {
      p_agent_id: agentId, p_task_id: taskId, p_reason: "The answer is incorrect.",
    });
    const review = () => rpc<Record<string, unknown>>("eyes_review_worker_disputes", {
      p_worker_id: workerId, p_actor: "operator-proof", p_note: "Reviewed the original evidence.", p_now: now,
    });
    const state = async () => (await sql`select * from workers where id = ${workerId}`)[0];
    const history = () => rpc("eyes_worker_dispute_history", { p_worker_id: workerId });
    const hold = async () => {
      const ids = await Promise.all([task(), task(), task()]);
      await Promise.all(ids.map(dispute));
      return ids;
    };
    return { agentId, workerId, task, dispute, review, state, history, hold };
  }

  it("counts three distinct genuine tasks atomically, never retries or test-tagged tasks, with no money changes", async () => {
    const f = await fixture();
    const genuine = await Promise.all([f.task(), f.task(), f.task()]);
    const synthetic = await Promise.all([f.task(true), f.task(true), f.task(true)]);
    const money = () => sql`select balance_cents, (select count(*)::int from ledger) as ledger_rows
      from agents where id = ${f.agentId}`;
    const before = await money();
    await Promise.all(synthetic.map(f.dispute));
    expect((await f.state())?.dispute_hold_at).toBeNull();
    await Promise.all(Array.from({ length: 5 }, () => f.dispute(genuine[0] as string)));
    expect(await f.history()).toHaveLength(1);
    expect((await f.state())?.dispute_hold_at).toBeNull();
    await Promise.all(genuine.slice(1).flatMap((id) => [f.dispute(id), f.dispute(id)]));
    expect(await f.history()).toHaveLength(3);
    expect((await f.state())?.dispute_hold_at).not.toBeNull();
    expect((await f.state())?.banned).toBe(false);
    expect(await money()).toEqual(before);
    expect(await sql`select id from tickets where worker_id = ${f.workerId} and kind = 'dispute'`).toHaveLength(6);
    expect(await sql`select id from events where summary = 'Worker held for dispute review'
      and data->>'worker_id' = ${f.workerId}`).toHaveLength(1);
  });

  it("blocks an already-issued offer at the claim race but preserves an existing capture and payout", async () => {
    const f = await fixture();
    await f.dispute(await f.task());
    await f.dispute(await f.task());
    const third = await f.task();
    const offered = await f.task(false, "dispatched");
    await sql`insert into offers (task_id, worker_id) values (${offered}, ${f.workerId})`;
    const gate = await sql.reserve();
    let pending: Promise<unknown> | undefined;
    try {
      await gate`begin`;
      await gate`select id from workers where id = ${f.workerId} for update`;
      pending = rpc("eyes_claim", { p_worker_id: f.workerId, p_now: now });
      await expect.poll(async () => Number((await sql`select count(*) as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%eyes_claim(%'`)[0]?.n)).toBeGreaterThan(0);
      await gate`select * from eyes_dispute(${f.agentId}::uuid, ${third}::uuid, 'Incorrect answer')`;
      await gate`commit`;
      expect(await pending).toEqual([]);
    } finally {
      await gate`rollback`;
      gate.release();
      if (pending) await pending;
    }
    expect((await sql`select status from tasks where id = ${offered}`)[0]?.status).toBe("dispatched");
    const current = await f.task(false, "claimed");
    expect(await rpc<{ outcome: string }>("eyes_claim", { p_worker_id: f.workerId, p_now: now }))
      .toMatchObject([{ outcome: "already_yours" }]);
    await rpc("eyes_submit", {
      p_task_id: current, p_worker_id: f.workerId, p_photo_url: "https://photos.test/proof.jpg",
      p_answer_text: "Open", p_answer_bool: true, p_lat: 37.77, p_lng: -122.4,
      p_captured_at: now, p_gps_ok: true, p_fresh_ok: true, p_vision_ok: true,
      p_vision_reason: "Verified", p_confidence: 1, p_auto_approve: true, p_now: now,
    });
    await rpc("eyes_record_payout", { p_task_id: current, p_transfer_id: `fake-${randomUUID()}`, p_now: now });
    expect((await sql`select status from tasks where id = ${current}`)[0]?.status).toBe("paid");
    expect((await f.state())?.dispute_hold_at).not.toBeNull();
  });

  it("excludes held workers from nearby, pings, reoffers and stale post-task candidates", async () => {
    const f = await fixture();
    const offered = await f.task(false, "dispatched");
    await sql`insert into offers (task_id, worker_id, sent_at)
      select id, ${f.workerId}, created_at from tasks where id = ${offered}`;
    await f.hold();
    const args = { p_lat: 37.77, p_lng: -122.4, p_radius_m: 1000, p_limit: 100,
      p_max_age: "24 hours", p_now: now };
    const nearby = await rpc<{ worker_id: string }>("eyes_nearby_workers", args);
    expect(nearby.map((w) => w.worker_id)).not.toContain(f.workerId);
    expect(await rpc("eyes_dispatchable_workers", { p_worker_ids: [f.workerId] })).toEqual([]);
    expect(await rpc("eyes_reoffer", { p_task_id: offered, p_released_by: randomUUID(),
      p_now: now, p_max_age: "24 hours" })).toEqual([]);
    await sql`update workers set location_at = now() - interval '2 days' where id = ${f.workerId}`;
    const pings = await rpc<{ worker_id: string }>("eyes_ping_candidates", args);
    expect(pings.map((w) => w.worker_id)).not.toContain(f.workerId);
    const money = (await sql`select balance_cents from agents where id = ${f.agentId}`)[0];
    await expect(rpc("eyes_post_task", {
      p_agent_id: f.agentId, p_question: "Is the shop open?", p_task_type: "is_open", p_place_label: "Shop",
      p_lat: 37.77, p_lng: -122.4, p_radius_m: 150, p_bounty_cents: 300, p_fee_cents: 50,
      p_require_photo: true, p_deadline_minutes: 30, p_idempotency_key: randomUUID(),
      p_worker_ids: [f.workerId], p_now: now,
    })).rejects.toMatchObject({ code: "no_workers_nearby" });
    expect((await sql`select balance_cents from agents where id = ${f.agentId}`)[0]).toEqual(money);
    await f.review();
    expect(await rpc("eyes_dispatchable_workers", { p_worker_ids: [f.workerId] })).toHaveLength(1);
  });

  it("resets the distinct-task checkpoint, audits the review, and serializes concurrent new disputes", async () => {
    const f = await fixture();
    const old = await f.hold();
    const newTask = await f.task();
    await Promise.all([f.review(), f.dispute(newTask)]);
    expect((await f.state())?.dispute_hold_at).toBeNull();
    expect((await f.history()).length).toBeLessThanOrEqual(1);
    expect((await f.state())?.dispute_last_review).toMatchObject({ actor: "operator-proof", decision: "lift_hold" });
    expect(await sql`select data from events where data->>'worker_id' = ${f.workerId}
      and summary = 'Worker dispute hold lifted'`).toHaveLength(1);
    // A resolved/reopened old task must not become a new distinct task after review.
    await sql`update tickets set status = 'resolved', dispute_status = 'rejected', resolved_at = now()
      where task_id = ${old[0] as string}`;
    await sql`update tasks set status = 'verified' where id = ${old[0] as string}`;
    const count = (await f.history()).length;
    await f.dispute(old[0] as string);
    expect(await f.history()).toHaveLength(count);
    expect((await f.state())?.dispute_hold_at).toBeNull();
    await Promise.all((await Promise.all([f.task(), f.task(), f.task()])).map(f.dispute));
    expect((await f.state())?.dispute_hold_at).not.toBeNull();
    await sql`update workers set banned = true where id = ${f.workerId}`;
    await f.review();
    expect((await f.state())?.banned).toBe(true);
    expect((await f.state())?.dispute_hold_at).toBeNull();
    expect(await rpc("eyes_dispatchable_workers", { p_worker_ids: [f.workerId] })).toEqual([]);
    expect(await rpc("eyes_claim", { p_worker_id: f.workerId, p_now: now })).toEqual([]);
  });

  it("does not backfill a hold, but includes old unreviewed genuine history on the next new dispute", async () => {
    const f = await fixture();
    const old = await Promise.all([f.task(), f.task(), f.task()]);
    for (const taskId of old) await sql`insert into tickets (worker_id, task_id, kind, dispute_status, message)
      values (${f.workerId}, ${taskId}, 'dispute', 'open', 'Historical dispute')`;
    expect((await f.state())?.dispute_hold_at).toBeNull();
    await f.dispute(await f.task(true));
    expect((await f.state())?.dispute_hold_at).toBeNull();
    await f.dispute(await f.task());
    expect((await f.state())?.dispute_hold_at).not.toBeNull();
  });
});
