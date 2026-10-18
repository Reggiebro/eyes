-- Setup completion is not the latest GPS fix. Only an accepted native app fix proves connection.
-- Older rows whose app fix was overwritten have no trustworthy history: the next normal app
-- report records it without a reinstall. Device registration and token use are not evidence.
alter table workers
  add column app_connected boolean not null default false,
  add column email_skipped boolean not null default false;

update workers set app_connected = true where location_source = 'app';

-- eyes_store_location only updates a worker after authentication and the existing rate/opt-in
-- checks. Capture/HERE/STOP updates keep the connection fact, without retaining any extra GPS.
create function eyes_record_worker_setup() returns trigger language plpgsql as $$
begin
  if new.location_source = 'app' and new.location_at is not null then
    new.app_connected := true;
  end if;
  if new.email is not null and
    (new.email is distinct from old.email or new.email_verified_at is distinct from old.email_verified_at) then
    new.email_skipped := false;
  end if;
  return new;
end $$;
create trigger worker_setup_state before update of location_at, email, email_verified_at on workers
  for each row execute function eyes_record_worker_setup();

-- Acknowledgement only: no email, verification, delivery, opt-in or token changes.
create function eyes_skip_worker_email(p_worker_id uuid) returns setof workers language sql as $$
  update workers set email_skipped = true where id = p_worker_id returning *
$$;
revoke execute on function eyes_record_worker_setup() from public;
revoke execute on function eyes_skip_worker_email(uuid) from public;
