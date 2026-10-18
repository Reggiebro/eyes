-- Test traffic apart from real traffic (T6.32). Agents, workers and tasks get a `test` flag; ops
-- counts, money totals, the Review queue and alerts leave flagged rows out, the map hides test
-- workers, and the panels tag them.
-- Going forward: an agent whose signup name starts with "smoke-" or "e2e-" is a test agent
-- (scripts/smoke-live.ts and the e2e specs sign up that way), and a task inherits its agent's flag.
-- Backfill: those agents, the ad hoc checkers named "...check" / "...test", the 4 end-to-end runs
-- on Oct 17 that used the operator's own agent and worker (each uploaded the same fake-camera
-- frame), and the "Apple Review" worker made for App Review, which has no real location.

alter table agents add column test boolean not null default false;
alter table workers add column test boolean not null default false;
alter table tasks add column test boolean not null default false;

create function eyes_agent_test_flag() returns trigger language plpgsql as $$
begin
  new.test := new.test or new.name ~* '^(smoke|e2e)-';
  return new;
end $$;
create trigger agents_test_flag before insert on agents for each row execute function eyes_agent_test_flag();

create function eyes_task_test_flag() returns trigger language plpgsql as $$
begin
  new.test := new.test or coalesce((select a.test from agents a where a.id = new.agent_id), false);
  return new;
end $$;
create trigger tasks_test_flag before insert on tasks for each row execute function eyes_task_test_flag();

update agents set test = true where name ~* '^(smoke|e2e)-|(check|test)$' or name in ('g1-golden-agent', 'demo-rehearsal-agent');
update tasks t set test = true from agents a where a.id = t.agent_id and a.test;
update tasks set test = true where id in (
  '91460d11-65e4-4a17-a3ed-dfabc29579f6', '1917245e-d808-4085-bcde-75ac99e2188f',
  'ef593d4f-ef01-43dc-b73b-512d05460b78', 'c89a5c9a-3e3d-4ccf-94ea-cde763e33f58');
update workers set test = true where name = 'Apple Review';

-- The feed now says which rows are tests; the escrow total leaves test tasks out.
create or replace function eyes_dashboard_feed(p_limit integer)
returns table (tasks jsonb, ledger jsonb, workers jsonb, totals jsonb) language sql stable as $$
  select
    coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at desc)
      from (
        select t.id, t.question, t.place_label, t.lat, t.lng, t.status, t.bounty_cents, t.fee_cents,
          t.created_at, t.claimed_at, t.deadline_at, t.test,
          (select count(*) from offers o where o.task_id = t.id)::integer as workers_notified,
          s.created_at as submitted_at, s.photo_url, s.gps_ok, s.fresh_ok, s.vision_ok, s.confidence,
          (select jsonb_object_agg(l.type, l.created_at) from ledger l where l.task_id = t.id) as money_at
        from tasks t
        left join lateral (
          select * from submissions sub where sub.task_id = t.id order by sub.created_at desc limit 1
        ) s on true
        order by t.created_at desc
        limit p_limit
      ) f
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select l.type, l.amount_cents, l.task_id, l.created_at,
          coalesce(t.test, a.test, false) as test
        from ledger l
        left join tasks t on t.id = l.task_id
        left join agents a on a.id = l.agent_id
        order by l.created_at desc limit p_limit
      ) l
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(w))
      from (
        select id, lat, lng, available, opted_in, test from workers order by created_at desc limit p_limit
      ) w
    ), '[]'::jsonb),
    (
      select jsonb_build_object(
        'escrowed_cents', coalesce(sum(case l.type when 'escrow' then l.amount_cents else -l.amount_cents end)
          filter (where l.type in ('escrow', 'release', 'fee', 'refund')), 0),
        'released_today_cents', coalesce(sum(l.amount_cents)
          filter (where l.type = 'release' and l.created_at >= date_trunc('day', now(), 'UTC')), 0),
        'paid_out_today_cents', coalesce(sum(l.amount_cents)
          filter (where l.type = 'payout' and l.created_at >= date_trunc('day', now(), 'UTC')), 0)
      )
      from ledger l
      left join tasks t on t.id = l.task_id
      left join agents a on a.id = l.agent_id
      where not coalesce(t.test, a.test, false)
    )
$$;

-- The Workers panel and the map tag test rows.
create or replace function eyes_ops_worker(p_id uuid, p_limit integer)
returns table (worker jsonb, tasks jsonb, earnings jsonb) language sql stable as $$
  select
    (select jsonb_build_object(
        'id', w.id, 'available', w.available, 'opted_in', w.opted_in, 'banned', w.banned, 'test', w.test,
        'lat', w.lat, 'lng', w.lng, 'location_at', coalesce(w.location_at, w.created_at),
        'location_source', w.location_source, 'created_at', w.created_at)
      from workers w where w.id = p_id),
    coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select t.id, t.question, t.place_label, t.status, t.bounty_cents, t.fee_cents, t.created_at, t.claimed_at,
          t.test,
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
      from ledger l
      left join tasks t on t.id = l.task_id
      where l.worker_id = p_id and not coalesce(t.test, false))
$$;

create or replace function eyes_map_tasks(p_status text, p_from timestamptz, p_to timestamptz, p_now timestamptz)
returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select t.id, t.question, t.place_label, t.lat, t.lng, t.status, t.bounty_cents, t.fee_cents,
      t.created_at, t.claimed_at, t.test,
      (select count(*) from offers o where o.task_id = t.id)::integer as workers_notified,
      (select s.created_at from submissions s where s.task_id = t.id order by s.created_at desc limit 1) as submitted_at,
      (select jsonb_object_agg(l.type, l.created_at) from ledger l where l.task_id = t.id) as money_at
    from tasks t
    where t.lat is not null and t.lng is not null and not (t.lat = 0 and t.lng = 0)
      and (p_status is null or t.status = p_status)
      and (
        t.status in ('dispatched', 'claimed', 'submitted', 'needs_review', 'disputed')
        or (t.created_at >= coalesce(p_from, p_now - interval '24 hours') and (p_to is null or t.created_at < p_to))
      )
    order by t.created_at desc
    limit 1000
  ) f
$$;

revoke execute on function eyes_agent_test_flag() from public;
revoke execute on function eyes_task_test_flag() from public;
