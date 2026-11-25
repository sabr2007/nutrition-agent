-- v2 phase reports to the owner (src/lib/telegram/phase-reports.ts): which ones were delivered.
alter table public.tg_chats add column if not exists reports_sent text[] not null default '{}';
