-- Workers can add email as a second channel next to their phone (T6.45). The phone stays required
-- (one account per number, the anti-abuse anchor); one email per account, unique. The email gets
-- offers only once verified (a link we sent was opened, or a DMARC-passing email arrived from it).
-- eyes_worker and eyes_set_worker_opt_in keep p_phone but also match the email, so replies by email
-- run the same code path.
alter table workers
  add column email text unique check (email = lower(email)),
  add column email_verified_at timestamptz;

-- One live sign-in or confirmation link code per email. The code is 32 random bytes, so only its
-- SHA-256 is stored and looked up; it works once.
create table worker_login_codes (
  code_hash text primary key,
  email text not null unique,
  expires_at timestamptz not null
);
alter table worker_login_codes enable row level security;

create or replace function eyes_worker(p_worker_id uuid, p_phone text)
returns setof workers language sql stable as $$
  select * from workers where id = p_worker_id or phone = p_phone or email = lower(p_phone)
$$;

-- Same as 002 plus an optional email, stored (unverified) only on a new row and only when no other
-- worker has it, so a repeat join still rewrites nothing. The 5-argument call keeps working.
drop function eyes_join_worker(text, text, double precision, double precision, timestamptz);
create function eyes_join_worker(p_name text, p_phone text, p_lat double precision, p_lng double precision,
  p_now timestamptz, p_email text default null)
returns setof workers language plpgsql as $$
begin
  return query
  insert into workers (name, phone, lat, lng, created_at, email)
  values (p_name, p_phone, p_lat, p_lng, p_now,
    case when not exists (select 1 from workers where email = lower(p_email)) then lower(p_email) end)
  on conflict (phone) do nothing
  returning *;
  if not found then
    return query select * from workers where phone = p_phone;
  end if;
end $$;

-- Verifies only for a phone-confirmed (opted-in) worker, so an email typed next to a phone nobody
-- has confirmed never becomes a channel. Returns the row either way.
create function eyes_verify_worker_email(p_email text, p_now timestamptz)
returns setof workers language sql as $$
  update workers set email_verified_at = case when opted_in then coalesce(email_verified_at, p_now) else email_verified_at end
  where email = lower(p_email) returning *
$$;

-- A join-form email whose phone never texted START within 24 hours is dropped (run by the sweep).
create function eyes_drop_pending_emails(p_now timestamptz)
returns setof workers language sql as $$
  update workers set email = null
  where email is not null and email_verified_at is null and not opted_in and created_at < p_now - interval '24 hours'
  returning *
$$;

-- Adds, changes (unverified again) or, with null, removes a worker's email. Fails on an email another
-- worker has (unique violation).
create function eyes_set_worker_email(p_worker_id uuid, p_email text)
returns setof workers language sql as $$
  update workers set email = lower(p_email),
    email_verified_at = case when email = lower(p_email) then email_verified_at end
  where id = p_worker_id returning *
$$;

create function eyes_issue_worker_code(p_email text, p_code_hash text, p_expires_at timestamptz)
returns setof worker_login_codes language sql as $$
  insert into worker_login_codes (code_hash, email, expires_at) values (p_code_hash, lower(p_email), p_expires_at)
  on conflict (email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at
  returning *
$$;

create function eyes_consume_worker_code(p_code_hash text, p_now timestamptz)
returns setof worker_login_codes language sql as $$
  delete from worker_login_codes where code_hash = p_code_hash and expires_at > p_now returning *
$$;

-- Same as 022, matched by phone or email; STOP also drops any login code.
create or replace function eyes_set_worker_opt_in(p_phone text, p_opted_in boolean)
returns setof workers language plpgsql as $$
begin
  if not p_opted_in then
    delete from worker_location_tokens t using workers w
      where (w.phone = p_phone or w.email = lower(p_phone)) and t.worker_id = w.id;
    delete from worker_devices d using workers w
      where (w.phone = p_phone or w.email = lower(p_phone)) and d.worker_id = w.id;
    delete from worker_login_codes c using workers w
      where (w.phone = p_phone or w.email = lower(p_phone)) and c.email = w.email;
  end if;
  return query
  update workers set
    opted_in = p_opted_in,
    available = p_opted_in,
    lat = case when p_opted_in then lat end,
    lng = case when p_opted_in then lng end,
    location_at = case when p_opted_in then location_at end,
    location_accuracy_m = case when p_opted_in then location_accuracy_m end,
    location_source = case when p_opted_in then location_source end,
    location_token_hash = null
  where (phone = p_phone or email = lower(p_phone)) and not (p_opted_in and banned)
  returning *;
end $$;

-- Dispatch returns each worker's verified email next to the phone.
drop function eyes_offer_more(uuid, integer, integer, interval, timestamptz);
drop function eyes_nearby_workers(double precision, double precision, integer, integer, interval, timestamptz);
create function eyes_nearby_workers(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval default '24 hours', p_now timestamptz default now())
returns table (worker_id uuid, phone text, email text, distance_m double precision) language sql stable as $$
  select id, phone, email, d from (
    select w.id, w.phone, case when w.email_verified_at is not null then w.email end as email,
      2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and w.lat is not null
      and coalesce(w.location_at, w.created_at) > p_now - p_max_age
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
  ) nearby
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

drop function eyes_ping_candidates(double precision, double precision, integer, integer, interval, timestamptz);
create function eyes_ping_candidates(p_lat double precision, p_lng double precision, p_radius_m integer,
  p_limit integer, p_max_age interval, p_now timestamptz)
returns table (worker_id uuid, phone text, email text, distance_m double precision) language sql stable as $$
  select id, phone, email, d from (
    select w.id, w.phone, case when w.email_verified_at is not null then w.email end as email,
      2 * 6371000 * asin(sqrt(
      power(sin(radians(w.lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(w.lat)) * power(sin(radians(w.lng - p_lng) / 2), 2)
    )) as d
    from workers w
    where w.available and w.opted_in and w.lat is not null
      and coalesce(w.location_at, w.created_at) <= p_now - p_max_age
      and not exists (select 1 from tasks t where t.claimed_by = w.id and t.status in ('claimed', 'submitted'))
      and not exists (select 1 from worker_pings p where p.worker_id = w.id and p.sent_at > p_now - interval '1 hour')
  ) stale
  where d <= p_radius_m
  order by d
  limit p_limit
$$;

create function eyes_offer_more(p_task_id uuid, p_radius_m integer, p_limit integer, p_max_age interval, p_now timestamptz)
returns table (worker_id uuid, phone text, email text, distance_m double precision) language plpgsql as $$
declare
  v_task tasks;
  v_room integer;
begin
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

revoke execute on function eyes_worker(uuid, text) from public;
revoke execute on function eyes_join_worker(text, text, double precision, double precision, timestamptz, text) from public;
revoke execute on function eyes_verify_worker_email(text, timestamptz) from public;
revoke execute on function eyes_drop_pending_emails(timestamptz) from public;
revoke execute on function eyes_set_worker_email(uuid, text) from public;
revoke execute on function eyes_issue_worker_code(text, text, timestamptz) from public;
revoke execute on function eyes_consume_worker_code(text, timestamptz) from public;
revoke execute on function eyes_set_worker_opt_in(text, boolean) from public;
revoke execute on function eyes_nearby_workers(double precision, double precision, integer, integer, interval, timestamptz) from public;
revoke execute on function eyes_ping_candidates(double precision, double precision, integer, integer, interval, timestamptz) from public;
revoke execute on function eyes_offer_more(uuid, integer, integer, interval, timestamptz) from public;
