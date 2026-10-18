-- Agent feedback is independent of machine verification and payment.
alter table tasks add column accepted_at timestamptz;

create function eyes_accept_answer(p_agent_id uuid, p_task_id uuid, p_now timestamptz)
returns setof tasks language plpgsql as $$
declare v_task tasks;
begin
  select * into v_task from tasks where id = p_task_id and agent_id = p_agent_id for update;
  if not found then raise exception 'eyes:task_not_found %', json_build_object('task_id', p_task_id); end if;
  if v_task.status not in ('verified', 'paid') or not exists (
    select 1 from submissions where task_id = p_task_id
  ) then
    raise exception 'eyes:task_not_acceptable %', json_build_object('task_id', p_task_id, 'status', v_task.status);
  end if;
  if v_task.accepted_at is null then
    update tasks set accepted_at = p_now where id = p_task_id returning * into v_task;
    insert into events(kind, task_id, summary, data, at)
    values ('answer_accepted', p_task_id, 'Agent accepted the answer',
      jsonb_build_object('agent_id', p_agent_id, 'accepted_at', p_now), p_now);
  end if;
  return next v_task;
end $$;
