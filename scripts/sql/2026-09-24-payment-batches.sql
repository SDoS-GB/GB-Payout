-- Owner payment batches, per-payout settlements, source-change flags (lib/db/schema.ts).
-- Idempotent: safe to run more than once. Apply with:
--   set -a && source /vercel/share/.env.project && set +a && node scripts/sql/apply.mjs scripts/sql/2026-09-24-payment-batches.sql

alter table payouts add column if not exists batch_id integer;
alter table payouts add column if not exists settled_kind text;
create index if not exists payouts_status_profile_idx on payouts (status, profile_id);
create index if not exists payouts_batch_idx on payouts (batch_id) where batch_id is not null;

create table if not exists payment_batches (
  id serial primary key,
  profile_id integer not null,
  kind text not null default 'payment',
  status text not null default 'recorded',
  method text,
  paid_on text,
  paid_amount numeric(12,2),
  calculated_total numeric(12,2) not null default 0,
  item_count integer not null default 0,
  reference text,
  idempotency_key text,
  recorded_at timestamptz not null default now(),
  recorded_by text not null,
  reversed_at timestamptz,
  reversed_by text,
  reversal_reason text,
  details jsonb
);
create unique index if not exists payment_batches_idempotency_unique on payment_batches (idempotency_key) where idempotency_key is not null;
create index if not exists payment_batches_profile_idx on payment_batches (profile_id, recorded_at desc);
create index if not exists payment_batches_recorded_idx on payment_batches (recorded_at desc);

create table if not exists payout_settlements (
  id serial primary key,
  batch_id integer not null,
  payout_id integer not null,
  profile_id integer not null,
  job_uuid text not null,
  amount numeric(12,2) not null,
  exact_amount numeric(12,4) not null,
  calc_version text,
  input_hash text,
  snapshot jsonb,
  status text not null default 'settled',
  created_at timestamptz not null default now(),
  reversed_at timestamptz
);
create unique index if not exists payout_settlements_active_unique on payout_settlements (payout_id) where status = 'settled';
create index if not exists payout_settlements_batch_idx on payout_settlements (batch_id);
create index if not exists payout_settlements_job_idx on payout_settlements (job_uuid);

create table if not exists payout_source_changes (
  id serial primary key,
  payout_id integer not null,
  job_uuid text not null,
  profile_id integer not null,
  settled_hash text,
  new_hash text not null,
  settled_amount numeric(12,4),
  recomputed_amount numeric(12,4),
  summary text,
  status text not null default 'open',
  detected_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text
);
create unique index if not exists payout_source_changes_hash_unique on payout_source_changes (payout_id, new_hash);
create index if not exists payout_source_changes_open_idx on payout_source_changes (status) where status = 'open';
