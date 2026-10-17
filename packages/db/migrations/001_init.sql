create extension if not exists pgcrypto;

create table agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_key_hash text not null unique,
  email_identity text unique,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  daily_cap_cents bigint not null default 2000 check (daily_cap_cents >= 0),
  max_bounty_cents bigint not null default 1000 check (max_bounty_cents >= 0),
  allowed_task_types text[] not null default array['is_open','line_length','in_stock','photo_of_place','price_check','crowd_level','other_public'],
  created_at timestamptz not null default now()
);

create table workers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name text not null,
  stripe_account_id text unique,
  lat double precision not null,
  lng double precision not null,
  available boolean not null default true,
  opted_in boolean not null default false,
  rating numeric(3,2) not null default 5.00,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id),
  question text not null,
  task_type text not null check (task_type in ('is_open','line_length','in_stock','photo_of_place','price_check','crowd_level','other_public')),
  place_label text not null,
  lat double precision not null,
  lng double precision not null,
  radius_m integer not null default 150,
  bounty_cents bigint not null check (bounty_cents > 0),
  fee_cents bigint not null check (fee_cents >= 0),
  require_photo boolean not null default true,
  deadline_at timestamptz not null,
  status text not null default 'dispatched' check (status in ('dispatched','claimed','submitted','verified','paid','expired','refunded','disputed','needs_review')),
  claimed_by uuid references workers(id),
  claimed_at timestamptz,
  idempotency_key text,
  dispute_reason text,
  created_at timestamptz not null default now(),
  unique (agent_id, idempotency_key),
  check ((claimed_by is null) = (claimed_at is null))
);
create index tasks_status_deadline on tasks (status, deadline_at);

create table offers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  worker_id uuid not null references workers(id),
  sent_at timestamptz not null default now(),
  unique (task_id, worker_id)
);
create index offers_worker_sent on offers (worker_id, sent_at desc);

create table submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  worker_id uuid not null references workers(id),
  photo_url text,
  answer_text text,
  answer_bool boolean,
  lat double precision not null,
  lng double precision not null,
  captured_at timestamptz not null,
  gps_ok boolean not null,
  fresh_ok boolean not null,
  vision_ok boolean not null,
  vision_reason text not null,
  confidence real not null check (confidence between 0 and 1),
  source text not null check (source in ('capture','email')),
  created_at timestamptz not null default now()
);
create index submissions_task on submissions (task_id, created_at desc);

create table ledger (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id),
  worker_id uuid references workers(id),
  task_id uuid references tasks(id),
  type text not null check (type in ('topup','escrow','release','refund','payout','fee')),
  amount_cents bigint not null check (amount_cents > 0),
  stripe_ref text,
  created_at timestamptz not null default now()
);
create unique index ledger_once_per_task on ledger (task_id, type) where task_id is not null;
create unique index ledger_stripe_ref on ledger (type, stripe_ref) where stripe_ref is not null;
