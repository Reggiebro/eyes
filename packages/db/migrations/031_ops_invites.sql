-- Access tab invites (T6.32): adding someone sends them a sign-in link (text for a phone, email for an
-- address). The row keeps the last invite's outcome: sent, copy (the email provider refused the
-- recipient, so the operator copies the link), or failed. At most 3 invites per entry per UTC day.

alter table ops_allowlist
  add column invite_status text check (invite_status in ('sent', 'copy', 'failed')),
  add column invite_at timestamptz,
  add column invite_day date,
  add column invites_today integer not null default 0;

-- Takes one of the day's 3 invites for p_id; no row when the entry is gone or the day's are used.
create function eyes_ops_invite_take(p_id uuid, p_now timestamptz)
returns setof ops_allowlist language sql as $$
  update ops_allowlist set
    invites_today = case when invite_day = (p_now at time zone 'UTC')::date then invites_today + 1 else 1 end,
    invite_day = (p_now at time zone 'UTC')::date
  where id = p_id
    and (invite_day is distinct from (p_now at time zone 'UTC')::date or invites_today < 3)
  returning *
$$;

create function eyes_ops_invite_record(p_id uuid, p_status text, p_now timestamptz)
returns setof ops_allowlist language sql as $$
  update ops_allowlist set invite_status = p_status, invite_at = p_now where id = p_id returning *
$$;

revoke execute on function eyes_ops_invite_take(uuid, timestamptz) from public;
revoke execute on function eyes_ops_invite_record(uuid, text, timestamptz) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_ops_invite_take(uuid, timestamptz) from %I', v_role);
    execute format('revoke execute on function eyes_ops_invite_record(uuid, text, timestamptz) from %I', v_role);
  end loop;
end $$;
