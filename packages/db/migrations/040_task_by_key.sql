create function eyes_task_by_key(p_agent_id uuid, p_idempotency_key text)
returns table (task tasks, workers_notified integer, escrowed_cents bigint)
language sql stable as $$
  select t,
    (select count(*)::integer from offers o where o.task_id = t.id),
    coalesce((
      select sum(case l.type when 'escrow' then l.amount_cents else -l.amount_cents end)
      from ledger l where l.task_id = t.id and l.type in ('escrow', 'release', 'fee', 'refund')
    ), 0)::bigint
  from tasks t where t.agent_id = p_agent_id and t.idempotency_key = p_idempotency_key
$$;

revoke execute on function eyes_task_by_key(uuid, text) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_task_by_key(uuid, text) from %I', v_role);
  end loop;
end $$;
