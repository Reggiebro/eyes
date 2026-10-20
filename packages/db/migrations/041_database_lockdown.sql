alter table events enable row level security;
alter table tickets enable row level security;
alter table ops_allowlist enable row level security;
alter table ops_codes enable row level security;
revoke all on table events, tickets, ops_allowlist, ops_codes from public;

do $$
declare v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table events, tickets, ops_allowlist, ops_codes from %I', v_role);
  end loop;
end $$;

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
  delete from worker_devices where worker_id = v_task.claimed_by;
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

create or replace function eyes_add_worker_device(p_worker_id uuid, p_udid text, p_product text, p_os_version text)
returns setof worker_devices language plpgsql as $$
begin
  if not exists (select 1 from workers where id = p_worker_id and opted_in for share) then
    return;
  end if;
  return query
  insert into worker_devices (udid, worker_id, product, os_version) values (p_udid, p_worker_id, p_product, p_os_version)
  on conflict (udid) do update set
    product = excluded.product,
    os_version = excluded.os_version,
    released_at = case when worker_devices.worker_id = excluded.worker_id then worker_devices.released_at end,
    worker_id = excluded.worker_id
  returning *;
end $$;
