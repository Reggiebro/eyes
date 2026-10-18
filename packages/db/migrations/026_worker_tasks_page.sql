-- The worker's /me task list (T6.42, ADR-029): every claimed task, newest first, a keyset page at a time, replacing
-- the separate earnings page. Search matches only what a row shows: question, place, the date as the
-- worker's browser shows it (`p_tz`, format of `shownDate()` in apps/web/worker/src/me.ts) and the amount
-- as "$3.00". p_filter is a status chip: paid, pending (released, not paid out), review, expired.
create function eyes_shown_date(p_at timestamptz, p_tz text) returns text
language sql stable as $$
  select to_char(p_at at time zone coalesce(p_tz, 'UTC'), 'Mon FMDD, YYYY')
$$;

create function eyes_worker_tasks_page(
  p_worker_id uuid, p_limit integer, p_q text, p_filter text, p_tz text,
  p_before_at timestamptz, p_before_id uuid
) returns setof jsonb language sql stable as $$
  select to_jsonb(f) from (
    select t.id as task_id, t.question, t.place_label, t.status, t.bounty_cents, t.claimed_at,
      exists (select 1 from ledger r where r.task_id = t.id and r.type = 'release') as released,
      (select min(p.created_at) from ledger p where p.task_id = t.id and p.type = 'payout') as paid_at
    from tasks t
    where t.claimed_by = p_worker_id
      and (p_before_at is null or (t.claimed_at, t.id) < (p_before_at, p_before_id))
      and (p_q is null or concat_ws(' ', t.question, t.place_label, eyes_shown_date(t.claimed_at, p_tz),
        eyes_shown_usd(t.bounty_cents)) ilike '%' || p_q || '%')
  ) f
  where p_filter is null
    or (p_filter = 'paid' and f.paid_at is not null)
    or (p_filter = 'pending' and f.released and f.paid_at is null)
    or (p_filter = 'review' and f.status in ('needs_review', 'disputed'))
    or (p_filter = 'expired' and f.status in ('expired', 'refunded'))
  order by f.claimed_at desc, f.task_id desc
  limit least(p_limit, 100)
$$;

revoke execute on function eyes_shown_date(timestamptz, text) from public;
revoke execute on function eyes_worker_tasks_page(uuid, integer, text, text, text, timestamptz, uuid) from public;

do $$
declare
  v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke execute on function eyes_shown_date(timestamptz, text) from %I', v_role);
    execute format('revoke execute on function eyes_worker_tasks_page(uuid, integer, text, text, text, timestamptz, uuid) from %I', v_role);
  end loop;
end $$;
