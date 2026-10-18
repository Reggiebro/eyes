-- Temporary dispute review is separate from permanent fraud bans. No worker backfill:
-- only a NEW genuine task dispute evaluates all unreviewed history. Test tasks never count.
alter table workers
  add column dispute_hold_at timestamptz,
  add column dispute_reviewed_at timestamptz,
  add column dispute_review_checkpoint bigint not null default 0,
  add column dispute_last_review jsonb;
create index tickets_worker_disputes on tickets (worker_id, task_id, id) where kind = 'dispute';

-- First ticket id, not timestamps or retry count: a previously reviewed task never counts again.
create function eyes_worker_dispute_history(p_worker_id uuid)
returns table (task_id uuid, created_at timestamptz, message text, dispute_status text)
language sql stable as $$
  select distinct on (k.task_id) k.task_id, k.created_at, k.message, k.dispute_status
  from tickets k join tasks t on t.id = k.task_id join workers w on w.id = k.worker_id
  where k.worker_id = p_worker_id and k.kind = 'dispute' and not t.test
    and not exists (select 1 from tickets old where old.worker_id = k.worker_id
      and old.task_id = k.task_id and old.kind = 'dispute' and old.id <= w.dispute_review_checkpoint)
  order by k.task_id, k.id desc
$$;

create function eyes_worker_dispute_review(p_worker_id uuid)
returns setof jsonb language sql stable as $$
  select jsonb_build_object('worker_id', w.id, 'dispute_hold_at', w.dispute_hold_at,
    'dispute_reviewed_at', w.dispute_reviewed_at, 'last_review', w.dispute_last_review,
    'disputed_tasks', (select count(*) from eyes_worker_dispute_history(w.id)),
    'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc)
      from eyes_worker_dispute_history(w.id) h), '[]'::jsonb))
  from workers w where w.id = p_worker_id
$$;

create function eyes_review_worker_disputes(p_worker_id uuid, p_actor text, p_note text, p_now timestamptz)
returns setof jsonb language plpgsql as $$
declare
  v_worker workers;
  v_review jsonb;
begin
  if length(trim(p_note)) not between 5 and 1000 or nullif(trim(p_actor), '') is null
    or p_note is null then
    raise exception 'eyes:invalid_input';
  end if;
  select * into v_worker from workers where id = p_worker_id for update;
  if not found then return; end if;
  if v_worker.dispute_hold_at is null then
    return next jsonb_build_object('error', 'worker_not_held');
    return;
  end if;
  v_review := jsonb_build_object('actor', p_actor, 'at', p_now, 'note', trim(p_note), 'decision', 'lift_hold');
  update workers set dispute_hold_at = null, dispute_reviewed_at = p_now,
    dispute_review_checkpoint = coalesce((select max(id) from tickets
      where worker_id = p_worker_id and kind = 'dispute'), 0),
    dispute_last_review = v_review
  where id = p_worker_id;
  -- No banned/opted_in/available or money changes. Keep every review in the existing audit log.
  insert into events (at, kind, summary, data) values
    (p_now, 'ops', 'Worker dispute hold lifted', v_review || jsonb_build_object('worker_id', p_worker_id));
  return query select * from eyes_worker_dispute_review(p_worker_id);
end $$;

-- Lock worker first, then task/ticket. Claims, reviews and fraud decisions use the same order.
create or replace function eyes_dispute(p_agent_id uuid, p_task_id uuid, p_reason text)
returns setof tasks language plpgsql as $$
declare
  v_task tasks;
  v_first boolean;
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  perform 1 from workers where id = (select claimed_by from tasks
    where id = p_task_id and agent_id = p_agent_id) for update;
  select * into v_task from tasks where id = p_task_id and agent_id = p_agent_id for update;
  if not found then
    raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id);
  end if;
  -- Repeated reports are idempotent and never create another countable ticket.
  if v_task.status = 'disputed' then return next v_task; return; end if;
  if v_task.status not in ('verified', 'paid', 'needs_review') then
    raise exception 'eyes:task_not_disputable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  v_first := not exists (select 1 from tickets where task_id = p_task_id and kind = 'dispute');
  update tasks set status = 'disputed', dispute_reason = p_reason where id = p_task_id returning * into v_task;
  insert into tickets (worker_id, task_id, kind, dispute_status, message, created_at)
  values (v_task.claimed_by, p_task_id, 'dispute', 'open', p_reason, v_now)
  on conflict (task_id, kind) where status = 'open' and kind in ('manual_review', 'dispute')
  do update set message = concat_ws(E'\n', nullif(tickets.message, ''), excluded.message);
  if v_first and not v_task.test then
    select count(*) into v_count from eyes_worker_dispute_history(v_task.claimed_by);
    if v_count >= 3 then
      update workers set dispute_hold_at = v_now
      where id = v_task.claimed_by and dispute_hold_at is null;
      if found then
        insert into events (at, kind, level, task_id, summary, data) values
          (v_now, 'ops', 'warn', p_task_id, 'Worker held for dispute review',
            jsonb_build_object('worker_id', v_task.claimed_by, 'disputed_tasks', v_count));
      end if;
    end if;
  end if;
  return next v_task;
end $$;

-- Preserve the fraud refund/reversal exactly; acquire its worker lock before ticket/task.
create or replace function eyes_confirm_fraud(p_ticket_id bigint, p_note text, p_now timestamptz)
returns table (ticket tickets, already boolean, refund_cents bigint, transfer_id text, payout_cents bigint)
language plpgsql as $$
declare
  v_ticket tickets;
  v_task tasks;
  v_released boolean;
begin
  perform 1 from workers where id = (select worker_id from tickets
    where id = p_ticket_id and kind = 'dispute') for update;
  select * into v_ticket from tickets where id = p_ticket_id and kind = 'dispute' for update;
  if not found then
    raise exception 'eyes:invalid_input %', json_build_object(
      'ticket_id', p_ticket_id,
      'issues', json_build_array(json_build_object('path', 'ticket_id', 'message', 'No dispute ticket with this id.'))
    );
  end if;
  if v_ticket.dispute_status <> 'open' then
    return query select v_ticket, true, null::bigint, null::text, null::bigint;
    return;
  end if;
  select * into v_task from tasks where id = v_ticket.task_id for update;
  v_released := exists (select 1 from ledger where task_id = v_task.id and type = 'release');
  -- Already refunded (ops refunded the task by hand first): ban and close without paying twice.
  if v_task.status <> 'refunded' then
    insert into ledger (agent_id, task_id, type, amount_cents, created_at)
    values (v_task.agent_id, v_task.id, case when v_released then 'fraud_refund' else 'refund' end,
      v_task.bounty_cents + v_task.fee_cents, p_now);
    update agents set balance_cents = balance_cents + v_task.bounty_cents + v_task.fee_cents
    where id = v_task.agent_id;
  end if;
  update tasks set status = 'refunded',
    dispute_reason = concat_ws(E'\n', dispute_reason, 'fraud confirmed: ' || p_note)
  where id = v_task.id;
  delete from worker_location_tokens where worker_id = v_task.claimed_by;
  update workers set banned = true, opted_in = false, available = false,
    lat = null, lng = null, location_at = null, location_accuracy_m = null, location_source = null,
    location_token_hash = null
  where id = v_task.claimed_by;
  update tickets set status = 'resolved', resolved_at = p_now, note = p_note, dispute_status = 'upheld'
  where id = p_ticket_id returning * into v_ticket;
  return query
  select v_ticket, false, case when v_task.status = 'refunded' then 0 else v_task.bounty_cents + v_task.fee_cents end::bigint,
    (select stripe_ref from ledger where task_id = v_task.id and type = 'payout'),
    (select amount_cents from ledger where task_id = v_task.id and type = 'payout');
end $$;

-- A hold blocks NEW claims, not an already captured valid task.
create or replace function eyes_claim(p_worker_id uuid, p_now timestamptz)
returns table (outcome text, task tasks) language plpgsql as $$
declare
  v_task tasks;
  v_won tasks;
begin
  perform 1 from workers where id = p_worker_id and opted_in and available and not banned for update;
  if not found then
    return;
  end if;

  return query
  select 'already_yours', t from tasks t
  where t.claimed_by = p_worker_id and t.status = 'claimed' and t.deadline_at > p_now
  order by t.claimed_at desc
  limit 1;
  if found then
    return;
  end if;

  if exists (select 1 from workers where id = p_worker_id and dispute_hold_at is not null) then
    return;
  end if;

  select t.* into v_task
  from offers o join tasks t on t.id = o.task_id
  where o.worker_id = p_worker_id and t.status = 'dispatched' and t.deadline_at > p_now
  order by o.sent_at desc
  limit 1;
  if found then
    update tasks set status = 'claimed', claimed_by = p_worker_id, claimed_at = p_now
    where id = v_task.id and status = 'dispatched'
    returning * into v_won;
    if found then
      return query select 'won', v_won;
      return;
    end if;
    return query
    select case when t.claimed_by = p_worker_id then 'already_yours' else 'lost' end, t
    from tasks t where t.id = v_task.id and t.claimed_by is not null;
    return;
  end if;

  return query
  select 'lost', t
  from offers o join tasks t on t.id = o.task_id
  where o.worker_id = p_worker_id and t.deadline_at > p_now and t.claimed_by <> p_worker_id
  order by o.sent_at desc
  limit 1;
end $$;

create or replace function eyes_post_task(
  p_agent_id uuid,
  p_question text,
  p_task_type text,
  p_place_label text,
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer,
  p_bounty_cents bigint,
  p_fee_cents bigint,
  p_require_photo boolean,
  p_deadline_minutes integer,
  p_idempotency_key text,
  p_worker_ids uuid[],
  p_now timestamptz
) returns table (task tasks, created boolean, workers_notified integer) language plpgsql as $$
declare
  v_agent agents;
  v_task tasks;
  v_total bigint := p_bounty_cents + p_fee_cents;
  v_spent bigint;
begin
  -- Recheck stale nearby results under locks before spending; deterministic worker order.
  perform 1 from workers where id = any(p_worker_ids) order by id for update;
  p_worker_ids := array(select id from workers where id = any(p_worker_ids)
    and opted_in and available and not banned and dispute_hold_at is null);
  select * into v_agent from agents where id = p_agent_id for update;

  if p_idempotency_key is not null then
    select * into v_task from tasks t where t.agent_id = p_agent_id and t.idempotency_key = p_idempotency_key;
    if found then
      if (v_task.question, v_task.task_type, v_task.place_label, v_task.lat, v_task.lng,
          v_task.bounty_cents, v_task.require_photo, v_task.deadline_at - v_task.created_at)
         is distinct from
         (p_question, p_task_type, p_place_label, p_lat, p_lng,
          p_bounty_cents, p_require_photo, make_interval(mins => p_deadline_minutes)) then
        raise exception 'eyes:idempotency_conflict %', json_build_object('task_id', v_task.id);
      end if;
      return query select v_task, false, (select count(*)::integer from offers o where o.task_id = v_task.id);
      return;
    end if;
  end if;

  v_spent := eyes_spent_today(p_agent_id, p_now);
  if v_spent + v_total > v_agent.daily_cap_cents then
    raise exception 'eyes:daily_cap_exceeded %',
      json_build_object('daily_cap_cents', v_agent.daily_cap_cents, 'spent_today_cents', v_spent);
  end if;

  if coalesce(cardinality(p_worker_ids), 0) = 0 then
    raise exception 'eyes:no_workers_nearby';
  end if;

  if v_agent.balance_cents < v_total then
    raise exception 'eyes:insufficient_balance %',
      json_build_object('balance_cents', v_agent.balance_cents, 'needed_cents', v_total);
  end if;

  update agents set balance_cents = balance_cents - v_total where id = p_agent_id;

  insert into tasks (agent_id, question, task_type, place_label, lat, lng, radius_m, bounty_cents, fee_cents,
    require_photo, deadline_at, idempotency_key, created_at)
  values (p_agent_id, p_question, p_task_type, p_place_label, p_lat, p_lng, p_radius_m, p_bounty_cents, p_fee_cents,
    p_require_photo, p_now + make_interval(mins => p_deadline_minutes), p_idempotency_key, p_now)
  returning * into v_task;

  insert into ledger (agent_id, task_id, type, amount_cents, created_at)
  values (p_agent_id, v_task.id, 'escrow', v_total, p_now);

  insert into offers (task_id, worker_id, sent_at)
  select v_task.id, w, p_now from unnest(p_worker_ids) w;

  return query select v_task, true, cardinality(p_worker_ids);
end $$;

create or replace function eyes_nearby_workers(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval default '24 hours', p_now timestamptz default now())
returns table (worker_id uuid, phone text, email text, distance_m double precision) language sql stable as $$
  select id, phone, email, d from (
    select w.id, w.phone, case when w.email_verified_at is not null then w.email end as email,
      2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and not w.banned and w.dispute_hold_at is null and w.lat is not null
      and coalesce(w.location_at, w.created_at) > p_now - p_max_age
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
  ) nearby
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create or replace function eyes_ping_candidates(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval, p_now timestamptz)
returns table (worker_id uuid, phone text, email text, distance_m double precision) language sql stable as $$
  select id, phone, email, d from (
    select w.id, w.phone, case when w.email_verified_at is not null then w.email end as email,
      2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and not w.banned and w.dispute_hold_at is null and w.lat is not null
      and coalesce(w.location_at, w.created_at) <= p_now - p_max_age
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
      and not exists (select 1 from worker_pings p where p.worker_id = w.id and p.sent_at > p_now - interval '1 hour')
  ) stale
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create or replace function eyes_offer_more(p_task_id uuid, p_radius_m integer, p_limit integer, p_max_age interval, p_now timestamptz)
returns table (worker_id uuid, phone text, email text, distance_m double precision) language plpgsql as $$
declare
  v_task tasks;
  v_room integer;
begin
  -- Worker locks precede the task lock, as in claim/dispute.
  perform 1 from workers w where w.id in (
    select n.worker_id from tasks t cross join lateral
      eyes_nearby_workers(t.lat, t.lng, p_radius_m, null, p_max_age, p_now) n
    where t.id = p_task_id) order by w.id for update;
  select * into v_task from tasks where id = p_task_id and status = 'dispatched' and deadline_at > p_now for update;
  if not found then
    return;
  end if;
  v_room := p_limit - (select count(*) from offers where task_id = p_task_id);
  if v_room <= 0 then
    return;
  end if;
  return query
  with picked as (
    select n.worker_id, n.phone, n.email, n.distance_m
    from eyes_nearby_workers(v_task.lat, v_task.lng, p_radius_m, null, p_max_age, p_now) n
    where not exists (select 1 from offers o where o.task_id = p_task_id and o.worker_id = n.worker_id)
    order by n.distance_m
    limit v_room
  ), ins as (
    insert into offers (task_id, worker_id, sent_at) select p_task_id, picked.worker_id, p_now from picked
  )
  select * from picked;
end $$;

create or replace function eyes_reoffer(p_task_id uuid, p_released_by uuid, p_now timestamptz, p_max_age interval default '24 hours')
returns setof workers language plpgsql as $$
begin
  perform 1 from workers w join offers o on o.worker_id = w.id
    where o.task_id = p_task_id order by w.id for update of w;
  return query update offers o set sent_at = p_now
  from tasks t, workers w
  where o.task_id = p_task_id and t.id = o.task_id and w.id = o.worker_id
    and o.sent_at = t.created_at
    and t.status = 'dispatched' and t.deadline_at > p_now
    and w.id <> p_released_by and w.available and w.opted_in and not w.banned and w.dispute_hold_at is null and w.lat is not null
    and coalesce(w.location_at, w.created_at) > p_now - p_max_age
    and not exists (select 1 from tasks c where c.claimed_by = w.id and c.status in ('claimed', 'submitted'))
  returning w.*;
end $$;

-- One final shared send-time filter covers initial offers, reoffers, iMessage and email.
create function eyes_dispatchable_workers(p_worker_ids uuid[])
returns setof uuid language sql stable as $$
  select id from workers where id = any(p_worker_ids)
    and opted_in and available and not banned and dispute_hold_at is null
$$;

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
        select id, lat, lng, available, opted_in, banned, dispute_hold_at, dispute_reviewed_at, test from workers order by created_at desc limit p_limit
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

create or replace function eyes_ops_worker(p_id uuid, p_limit integer)
returns table (worker jsonb, tasks jsonb, earnings jsonb) language sql stable as $$
  select
    (select jsonb_build_object(
        'id', w.id, 'available', w.available, 'opted_in', w.opted_in, 'banned', w.banned, 'test', w.test,
        'dispute_hold_at', w.dispute_hold_at, 'dispute_reviewed_at', w.dispute_reviewed_at,
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

-- New RPCs are server-only, like existing operational RPCs; no SECURITY DEFINER surface.
do $$
declare v_fn text; v_role text;
begin
  foreach v_fn in array array[
    'eyes_worker_dispute_history(uuid)', 'eyes_worker_dispute_review(uuid)',
    'eyes_review_worker_disputes(uuid,text,text,timestamptz)', 'eyes_dispatchable_workers(uuid[])'
  ] loop
    execute format('revoke execute on function %s from public', v_fn);
    for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
      execute format('revoke execute on function %s from %I', v_fn, v_role);
    end loop;
  end loop;
end $$;
