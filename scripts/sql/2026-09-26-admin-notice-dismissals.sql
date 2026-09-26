-- Cleared admin notifications (lib/db/schema.ts adminNoticeDismissals). Additive only; touches no payout data.
-- Idempotent: safe to run more than once. Apply with:
--   set -a && source /vercel/share/.env.project && set +a && node scripts/sql/apply.mjs scripts/sql/2026-09-26-admin-notice-dismissals.sql

create table if not exists admin_notice_dismissals (
  id serial primary key,
  account text not null default 'admin',
  notice_key text not null,
  dismissed_at timestamptz not null default now(),
  dismissed_by text not null default 'admin'
);
create unique index if not exists admin_notice_dismissals_unique on admin_notice_dismissals (account, notice_key);
