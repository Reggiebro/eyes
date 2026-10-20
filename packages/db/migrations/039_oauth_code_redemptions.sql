create table oauth_code_redemptions (
  code_hash text primary key
);
alter table oauth_code_redemptions enable row level security;
revoke all on table oauth_code_redemptions from public;

create function eyes_redeem_oauth_code(p_code_hash text)
returns setof oauth_code_redemptions language sql as $$
  insert into oauth_code_redemptions (code_hash) values (p_code_hash)
  on conflict (code_hash) do nothing
  returning *
$$;
revoke execute on function eyes_redeem_oauth_code(text) from public;

do $$
declare v_role text;
begin
  for v_role in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    execute format('revoke all on table oauth_code_redemptions from %I', v_role);
    execute format('revoke execute on function eyes_redeem_oauth_code(text) from %I', v_role);
  end loop;
end $$;
