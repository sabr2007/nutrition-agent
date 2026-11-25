-- v2 (D25): Telegram bot as the main interface.
--  * profiles: the owner's Telegram ids, set once by pairing (/start <code>).
--  * tg_pairings: used pairing codes (sha256) — a code works once even if it stays in env.
--  * tg_updates: every webhook update, unique by update_id (Telegram retries → idempotent);
--    foreign senders are stored without content. Status drives retries from the cron tick.
--  * tg_chats: one worker per chat at a time (lease), /deep and /mute state, refusal throttle.
--  * tg_callbacks: inline-button payloads (callback_data holds only the short id).
-- All tg_* tables are server-only: RLS on, no policies (the service role bypasses RLS).

alter table public.profiles add column if not exists telegram_user_id bigint;
alter table public.profiles add column if not exists telegram_chat_id bigint;
alter table public.profiles add column if not exists telegram_linked_at timestamptz;
create unique index if not exists profiles_telegram_user on public.profiles (telegram_user_id) where telegram_user_id is not null;

create table if not exists public.tg_pairings (
  code_sha256 text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  telegram_user_id bigint not null,
  used_at timestamptz not null default now()
);

create table if not exists public.tg_updates (
  update_id bigint primary key,
  chat_id bigint,
  user_id uuid references auth.users (id) on delete cascade,
  kind text not null,
  media_group_id text,
  payload jsonb not null default '{}',
  status text not null default 'received' check (status in ('received', 'processing', 'done', 'failed', 'ignored')),
  attempts integer not null default 0,
  error text,
  run_id uuid,
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists tg_updates_open on public.tg_updates (chat_id, update_id) where status in ('received', 'processing', 'failed');

create table if not exists public.tg_chats (
  chat_id bigint primary key,
  user_id uuid references auth.users (id) on delete cascade,
  lease_until timestamptz,
  lease_owner text,
  deep_next boolean not null default false,
  muted_until timestamptz,
  last_refusal_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.tg_callbacks (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_id bigint not null,
  message_id bigint,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz
);
create index if not exists tg_callbacks_message on public.tg_callbacks (chat_id, message_id);

alter table public.tg_pairings enable row level security;
alter table public.tg_updates enable row level security;
alter table public.tg_chats enable row level security;
alter table public.tg_callbacks enable row level security;
revoke all on public.tg_pairings, public.tg_updates, public.tg_chats, public.tg_callbacks from anon, authenticated;

-- Lease a chat for one worker; the same owner may extend its lease.
create or replace function public.tg_acquire_chat(p_chat bigint, p_owner text, p_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  got boolean;
begin
  insert into public.tg_chats (chat_id) values (p_chat) on conflict (chat_id) do nothing;
  update public.tg_chats
     set lease_until = now() + make_interval(secs => p_seconds), lease_owner = p_owner, updated_at = now()
   where chat_id = p_chat and (lease_until is null or lease_until < now() or lease_owner = p_owner)
  returning true into got;
  return coalesce(got, false);
end
$$;

create or replace function public.tg_release_chat(p_chat bigint, p_owner text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.tg_chats set lease_until = null, lease_owner = null, updated_at = now()
   where chat_id = p_chat and lease_owner = p_owner
$$;

-- The oldest waiting update of a chat, marked processing (skip rows another worker holds).
create or replace function public.tg_claim_next(p_chat bigint)
returns setof public.tg_updates
language sql
security definer
set search_path = ''
as $$
  update public.tg_updates u
     set status = 'processing', attempts = u.attempts + 1, started_at = now(), error = null
   where u.update_id = (
     select update_id from public.tg_updates
      where chat_id = p_chat and status = 'received'
      order by update_id
      limit 1
      for update skip locked)
  returning u.*
$$;

-- Several waiting updates of one album at once.
create or replace function public.tg_claim_group(p_chat bigint, p_group text)
returns setof public.tg_updates
language sql
security definer
set search_path = ''
as $$
  update public.tg_updates u
     set status = 'processing', attempts = u.attempts + 1, started_at = now(), error = null
   where u.chat_id = p_chat and u.media_group_id = p_group and u.status = 'received'
  returning u.*
$$;

revoke execute on function public.tg_acquire_chat(bigint, text, integer) from public, anon, authenticated;
revoke execute on function public.tg_release_chat(bigint, text) from public, anon, authenticated;
revoke execute on function public.tg_claim_next(bigint) from public, anon, authenticated;
revoke execute on function public.tg_claim_group(bigint, text) from public, anon, authenticated;
grant execute on function public.tg_acquire_chat(bigint, text, integer) to service_role;
grant execute on function public.tg_release_chat(bigint, text) to service_role;
grant execute on function public.tg_claim_next(bigint) to service_role;
grant execute on function public.tg_claim_group(bigint, text) to service_role;

-- Cron safety net: stuck (processing > 5 min) and failed updates go back to the queue until
-- max attempts; returns chats whose waiting updates nobody picked up (a lost after()).
create or replace function public.tg_requeue(p_max_attempts integer default 3)
returns table (chat_id bigint, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tg_updates set status = 'failed', error = coalesce(error, 'timed out'), finished_at = now()
   where status = 'processing' and started_at < now() - interval '5 minutes' and attempts >= p_max_attempts;
  update public.tg_updates set status = 'received'
   where (status = 'processing' and started_at < now() - interval '5 minutes' and attempts < p_max_attempts)
      or (status = 'failed' and attempts < p_max_attempts and finished_at < now() - interval '1 minute');
  return query
    select distinct u.chat_id, u.user_id from public.tg_updates u
     where u.status = 'received' and u.user_id is not null and u.received_at < now() - interval '20 seconds';
end
$$;
revoke execute on function public.tg_requeue(integer) from public, anon, authenticated;
grant execute on function public.tg_requeue(integer) to service_role;
