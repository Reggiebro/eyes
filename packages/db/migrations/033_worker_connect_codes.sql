-- Workers add email by emailing us first (T6.51): Primitive only sends to people who wrote to us.
-- A text or /me hands the worker a mailto with a one-time code; the DMARC-passing email that carries
-- it sets the sender as the worker's email, verified. One live code per worker, SHA-256 at rest.
create table worker_connect_codes (
  code_hash text primary key,
  worker_id uuid not null unique references workers (id) on delete cascade,
  expires_at timestamptz not null
);
alter table worker_connect_codes enable row level security;

create function eyes_issue_connect_code(p_worker_id uuid, p_code_hash text, p_expires_at timestamptz)
returns setof worker_connect_codes language sql as $$
  insert into worker_connect_codes (code_hash, worker_id, expires_at) values (p_code_hash, p_worker_id, p_expires_at)
  on conflict (worker_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at
  returning *
$$;

-- Uses the code and sets the email, verified, for an opted-in worker. No row: bad, used or expired
-- code (or the worker opted out). An email another worker has fails (unique violation) and rolls
-- back, so the code stays usable.
create function eyes_connect_worker_email(p_code_hash text, p_email text, p_now timestamptz)
returns setof workers language plpgsql as $$
declare
  v_worker_id uuid;
begin
  delete from worker_connect_codes where code_hash = p_code_hash and expires_at > p_now
    returning worker_id into v_worker_id;
  if v_worker_id is null then
    return;
  end if;
  return query
  update workers set email = lower(p_email), email_verified_at = p_now
  where id = v_worker_id and opted_in and not banned returning *;
end $$;

revoke execute on function eyes_issue_connect_code(uuid, text, timestamptz) from public;
revoke execute on function eyes_connect_worker_email(text, text, timestamptz) from public;
