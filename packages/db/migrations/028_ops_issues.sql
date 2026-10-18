-- Server errors grouped into issues for the ops Errors tab (T6.32), Sentry-style. The server
-- fingerprints each console error/warning (name, normalized message, top in-app frame; see
-- apps/web/dashboard/src/issues.ts) and records batches here. Issues and their status survive
-- restarts. A resolved issue that happens again reopens as regressed; an ignored one comes back
-- after N more occurrences (ignore_until is the count to reach), or never when ignore_until is null.
-- Occurrences are kept 14 days, for the sparkline, the latest list and who was affected.

create table ops_issues (
  fingerprint text primary key,
  level text not null check (level in ('warn', 'error')),
  title text not null,
  culprit text,
  status text not null default 'unresolved' check (status in ('unresolved', 'resolved', 'ignored')),
  regressed boolean not null default false,
  ignore_until integer,
  count integer not null default 0,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  message text not null,
  stack text,
  status_by text,
  status_at timestamptz
);
create index ops_issues_last_seen on ops_issues (last_seen desc);

create table ops_issue_events (
  id bigserial primary key,
  fingerprint text not null references ops_issues (fingerprint) on delete cascade,
  at timestamptz not null,
  message text not null,
  tags jsonb not null default '{}'
);
create index ops_issue_events_fp_at on ops_issue_events (fingerprint, at desc);
create index ops_issue_events_at on ops_issue_events (at);
alter table ops_issues enable row level security;
alter table ops_issue_events enable row level security;

-- p_events: [{fingerprint, level, title, culprit, message, stack, at, tags}], oldest first.
create function eyes_issues_record(p_events jsonb)
returns integer language plpgsql as $$
declare
  e record;
  n integer := 0;
begin
  for e in
    select * from jsonb_to_recordset(p_events) as x(fingerprint text, level text, title text, culprit text,
      message text, stack text, at timestamptz, tags jsonb)
  loop
    insert into ops_issues as i (fingerprint, level, title, culprit, count, first_seen, last_seen, message, stack)
    values (e.fingerprint, e.level, e.title, e.culprit, 1, e.at, e.at, e.message, e.stack)
    on conflict (fingerprint) do update set
      count = i.count + 1,
      last_seen = greatest(i.last_seen, excluded.last_seen),
      level = case when excluded.level = 'error' then 'error' else i.level end,
      message = excluded.message,
      stack = coalesce(excluded.stack, i.stack),
      regressed = i.regressed or i.status = 'resolved',
      status = case
        when i.status = 'resolved' then 'unresolved'
        when i.status = 'ignored' and i.ignore_until is not null and i.count + 1 >= i.ignore_until then 'unresolved'
        else i.status end,
      ignore_until = case
        when i.status = 'ignored' and i.ignore_until is not null and i.count + 1 >= i.ignore_until then null
        else i.ignore_until end;
    insert into ops_issue_events (fingerprint, at, message, tags)
    values (e.fingerprint, e.at, e.message, coalesce(e.tags, '{}'::jsonb));
    n := n + 1;
  end loop;
  delete from ops_issue_events where at < now() - interval '14 days';
  return n;
end $$;

-- Every issue with its 24 hourly counts up to p_now (oldest first) and how many workers, agents
-- and tasks its occurrences named.
create function eyes_issues(p_now timestamptz)
returns setof jsonb language sql stable as $$
  select to_jsonb(i) || jsonb_build_object(
    'spark', (
      select jsonb_agg(coalesce(c.n, 0) order by h.k)
      from generate_series(0, 23) as h(k)
      left join lateral (
        select count(*)::integer as n from ops_issue_events v
        where v.fingerprint = i.fingerprint
          and v.at >= p_now - interval '24 hours' + h.k * interval '1 hour'
          and v.at < p_now - interval '23 hours' + h.k * interval '1 hour'
      ) c on true),
    'affected', (
      select jsonb_build_object(
        'workers', count(distinct v.tags ->> 'worker_id'),
        'agents', count(distinct v.tags ->> 'agent_id'),
        'tasks', count(distinct v.tags ->> 'task_id'))
      from ops_issue_events v where v.fingerprint = i.fingerprint))
  from ops_issues i
  order by i.last_seen desc
  limit 500
$$;

create function eyes_issue_events(p_fingerprint text, p_limit integer)
returns setof ops_issue_events language sql stable as $$
  select * from ops_issue_events where fingerprint = p_fingerprint order by at desc, id desc limit least(p_limit, 100)
$$;

-- p_status: resolved, ignored (p_more: come back after that many more; null: forever) or unresolved.
create function eyes_issue_status(p_fingerprint text, p_status text, p_more integer, p_by text, p_now timestamptz)
returns setof ops_issues language sql as $$
  update ops_issues set
    status = p_status,
    regressed = case when p_status = 'unresolved' then regressed else false end,
    ignore_until = case when p_status = 'ignored' and p_more is not null then count + p_more end,
    status_by = p_by,
    status_at = p_now
  where fingerprint = p_fingerprint and p_status in ('unresolved', 'resolved', 'ignored')
  returning *
$$;

revoke all on table ops_issues, ops_issue_events from public;
revoke execute on function eyes_issues_record(jsonb) from public;
revoke execute on function eyes_issues(timestamptz) from public;
revoke execute on function eyes_issue_events(text, integer) from public;
revoke execute on function eyes_issue_status(text, text, integer, text, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table ops_issues, ops_issue_events from %I', v_role);
    execute format('revoke execute on function eyes_issues_record(jsonb) from %I', v_role);
    execute format('revoke execute on function eyes_issues(timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_issue_events(text, integer) from %I', v_role);
    execute format('revoke execute on function eyes_issue_status(text, text, integer, text, timestamptz) from %I', v_role);
  end loop;
end $$;
