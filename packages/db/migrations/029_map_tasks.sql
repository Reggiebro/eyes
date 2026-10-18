-- Tasks for the ops Workers map (T6.32). Before, the map drew the dashboard feed's tasks, fitted to the
-- live ones, and drew attention tasks first, so a needs-review task sharing a spot with paid ones was
-- hidden under them. This returns every task with a location in the window the Tasks tab's filters
-- pick ([p_from, p_to); with no window, the last 24 h before p_now), plus every open or
-- attention task (dispatched, claimed, submitted, needs_review, disputed) whatever its age.
-- p_status narrows both. Production has no demo rows: the sandbox never writes to this database.
create function eyes_map_tasks(p_status text, p_from timestamptz, p_to timestamptz, p_now timestamptz)
returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select t.id, t.question, t.place_label, t.lat, t.lng, t.status, t.bounty_cents, t.fee_cents,
      t.created_at, t.claimed_at,
      (select count(*) from offers o where o.task_id = t.id)::integer as workers_notified,
      (select s.created_at from submissions s where s.task_id = t.id order by s.created_at desc limit 1) as submitted_at,
      (select jsonb_object_agg(l.type, l.created_at) from ledger l where l.task_id = t.id) as money_at
    from tasks t
    where t.lat is not null and t.lng is not null
      and (p_status is null or t.status = p_status)
      and (
        t.status in ('dispatched', 'claimed', 'submitted', 'needs_review', 'disputed')
        or (t.created_at >= coalesce(p_from, p_now - interval '24 hours') and (p_to is null or t.created_at < p_to))
      )
    order by t.created_at desc
    limit 1000
  ) f
$$;

revoke execute on function eyes_map_tasks(text, timestamptz, timestamptz, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_map_tasks(text, timestamptz, timestamptz, timestamptz) from %I', v_role);
  end loop;
end $$;
