-- One worker for the ops Workers panel (T6.32): state and last location fix, the tasks they claimed
-- or answered (newest first, with the timeline fields the task panel uses), and what they earned.
-- No phone or name: the panel shows the short id only. The server rounds the position.
create or replace function eyes_ops_worker(p_id uuid, p_limit integer)
returns table (worker jsonb, tasks jsonb, earnings jsonb) language sql stable as $$
  select
    (select jsonb_build_object(
        'id', w.id, 'available', w.available, 'opted_in', w.opted_in, 'banned', w.banned,
        'lat', w.lat, 'lng', w.lng, 'location_at', coalesce(w.location_at, w.created_at),
        'location_source', w.location_source, 'created_at', w.created_at)
      from workers w where w.id = p_id),
    coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select t.id, t.question, t.place_label, t.status, t.bounty_cents, t.fee_cents, t.created_at, t.claimed_at,
          (select count(*) from offers o where o.task_id = t.id)::integer as workers_notified,
          s.created_at as submitted_at, s.photo_url, s.answer_text, s.answer_bool,
          s.gps_ok, s.fresh_ok, s.vision_ok, s.vision_reason, s.confidence,
          (select jsonb_object_agg(l.type, l.created_at) from ledger l where l.task_id = t.id) as money_at
        from tasks t
        left join lateral (
          select * from submissions sub where sub.task_id = t.id and sub.worker_id = p_id
          order by sub.created_at desc limit 1
        ) s on true
        where t.claimed_by = p_id or s.id is not null
        order by t.created_at desc
        limit least(p_limit, 50)
      ) x), '[]'::jsonb),
    (select jsonb_build_object(
        'paid_cents', coalesce(sum(l.amount_cents) filter (where l.type = 'payout'), 0),
        'payouts', count(*) filter (where l.type = 'payout'),
        'released_cents', coalesce(sum(l.amount_cents) filter (where l.type = 'release'), 0),
        'last_paid_at', max(l.created_at) filter (where l.type = 'payout'))
      from ledger l where l.worker_id = p_id)
$$;

revoke execute on function eyes_ops_worker(uuid, integer) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_ops_worker(uuid, integer) from %I', v_role);
  end loop;
end $$;
