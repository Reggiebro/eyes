-- T6.57: one allowlisted setting, never a generic secrets endpoint.
create table public.ops_settings (
  key text primary key check (key = 'classifier_block_min'),
  value double precision not null check (value between 0.5 and 1.0),
  updated_at timestamptz not null default now(),
  updated_by text not null
);
alter table public.ops_settings enable row level security;
revoke all on public.ops_settings from public;

create function public.eyes_ops_settings()
returns table (classifier_block_min double precision, "default" double precision, updated_at timestamptz, updated_by text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(s.value, 0.95), 0.95::double precision, s.updated_at, s.updated_by
  from (values (1)) singleton(n)
  left join public.ops_settings s on s.key = 'classifier_block_min'
$$;

create function public.eyes_ops_settings_set(p_value double precision, p_actor text)
returns table (classifier_block_min double precision, "default" double precision, updated_at timestamptz, updated_by text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_before double precision;
  v_actor text;
begin
  if p_value is null or not (p_value between 0.5 and 1.0) then
    raise exception 'eyes:invalid_input {"field":"classifier_block_min"}';
  end if;
  if p_actor is null or length(btrim(p_actor)) = 0 or length(p_actor) > 200 then
    raise exception 'eyes:invalid_input {"field":"actor"}';
  end if;
  v_actor := case when position('@' in p_actor) > 0 then '***@' || split_part(p_actor, '@', 2)
    when left(p_actor, 1) = '+' then '***' || right(p_actor, 4) else p_actor end;
  -- Serialize the first insert too, so concurrent saves have an accurate before/after audit chain.
  perform pg_advisory_xact_lock(hashtextextended('eyes:classifier_block_min', 0));
  select s.value into v_before from public.ops_settings s where s.key = 'classifier_block_min';
  insert into public.ops_settings as s (key, value, updated_at, updated_by)
    values ('classifier_block_min', p_value, clock_timestamp(), v_actor)
    on conflict (key) do update set value = excluded.value,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.events (kind, level, summary, data) values (
    'ops', 'info', 'classifier threshold changed by ' || v_actor,
    jsonb_build_object('action', 'classifier_block_min', 'before', coalesce(v_before, 0.95),
      'after', p_value, 'operator', v_actor)
  );
  return query select * from public.eyes_ops_settings();
end $$;

revoke execute on function public.eyes_ops_settings() from public;
revoke execute on function public.eyes_ops_settings_set(double precision, text) from public;
do $$
declare v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on public.ops_settings from %I', v_role);
    execute format('revoke execute on function public.eyes_ops_settings() from %I', v_role);
    execute format('revoke execute on function public.eyes_ops_settings_set(double precision, text) from %I', v_role);
  end loop;
  for v_role in select rolname from pg_roles where rolname in ('project_admin', 'service_role') loop
    execute format('grant execute on function public.eyes_ops_settings() to %I', v_role);
    execute format('grant execute on function public.eyes_ops_settings_set(double precision, text) to %I', v_role);
  end loop;
end $$;
