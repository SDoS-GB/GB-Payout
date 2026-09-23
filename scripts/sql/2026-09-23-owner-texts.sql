-- Owner "payout ready" texts, durable webhook log, Workiz job-id map (lib/db/schema.ts).
-- Idempotent: safe to run more than once. Apply with:
--   set -a && source /vercel/share/.env.project && set +a && node scripts/sql/apply.mjs scripts/sql/2026-09-23-owner-texts.sql

alter table job_payments
  add column if not exists paid_at_from_payload boolean not null default false;

create table if not exists webhook_events (
  id serial primary key,
  event_key text not null,
  trigger_type text,
  rule_name text,
  kind text not null,
  job_uuid text,
  job_internal_id text,
  serial_id text,
  document_id text,
  payload jsonb,
  status text not null default 'received',
  attempts integer not null default 0,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists webhook_events_key_unique on webhook_events (event_key);
create index if not exists webhook_events_status_idx on webhook_events (status, received_at);
create index if not exists webhook_events_job_internal_idx on webhook_events (job_internal_id) where job_internal_id is not null;

create table if not exists workiz_job_ids (
  internal_id text primary key,
  uuid text not null,
  serial_id text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workiz_job_ids_uuid_idx on workiz_job_ids (uuid);

create table if not exists owner_notifications (
  id serial primary key,
  job_uuid text not null,
  status text not null default 'blocked',
  block_reason text,
  snapshot_hash text,
  sent_snapshot_hash text,
  message text not null default '',
  channel text not null default 'workiz_tag_sms',
  destination_label text,
  destination_masked text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  provider_response jsonb,
  sent_at timestamptz,
  delivered_at timestamptz,
  delivered_confirmed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists owner_notifications_job_unique on owner_notifications (job_uuid);
create index if not exists owner_notifications_due_idx on owner_notifications (status, next_attempt_at);
