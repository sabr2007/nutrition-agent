-- v2 (D28): wearable data from the Google Health API (and the Apple Shortcuts import as a backup).
--  * health_daily: one row per user, local day and source — steps, active/total kcal, resting HR.
--  * health_sleep: one row per user, night and source — start, end, minutes asleep, stages.
--  * workouts: Google Health sessions land here too, deduplicated by external_id.
--  * The old Shortcuts import wrote steps and sleep as checklist marks; those rows move here
--    (source 'shortcuts') before the checklist is retired.

create table if not exists public.health_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  local_day date not null,
  source text not null check (source in ('google_health', 'shortcuts', 'manual')),
  steps integer check (steps >= 0),
  active_kcal numeric(7, 1) check (active_kcal >= 0),
  total_kcal numeric(7, 1) check (total_kcal >= 0),
  resting_hr numeric(5, 1) check (resting_hr > 0),
  synced_at timestamptz not null default now(),
  primary key (user_id, local_day, source)
);

create table if not exists public.health_sleep (
  user_id uuid not null references auth.users (id) on delete cascade,
  night_of date not null,
  source text not null check (source in ('google_health', 'shortcuts', 'manual')),
  start_at timestamptz,
  end_at timestamptz,
  minutes integer check (minutes >= 0),
  stages jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  primary key (user_id, night_of, source)
);

alter table public.workouts drop constraint if exists workouts_source_check;
alter table public.workouts add constraint workouts_source_check check (source in ('user', 'schedule', 'agent', 'import', 'google_health'));
alter table public.workouts add column if not exists external_id text;
alter table public.workouts add column if not exists kcal numeric(7, 1);
alter table public.workouts add column if not exists duration_min integer;
alter table public.workouts add column if not exists avg_hr integer;
-- Not partial: PostgREST upserts need a plain unique index (NULL external ids never conflict).
create unique index if not exists workouts_external on public.workouts (user_id, source, external_id);

do $$
declare
  t text;
begin
  foreach t in array array['health_daily', 'health_sleep'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t || '_delete_own', t);
  end loop;
end
$$;

-- Journal (tg_log_event falls back to the user id as entity_id). The sync re-upserts the same days
-- every 15 minutes, so an update is journaled only when a value really changed.
create trigger health_daily_journal after insert on public.health_daily for each row execute function public.tg_log_event();
create trigger health_daily_journal_update after update on public.health_daily for each row
  when (old.steps is distinct from new.steps or old.active_kcal is distinct from new.active_kcal
        or old.total_kcal is distinct from new.total_kcal or old.resting_hr is distinct from new.resting_hr)
  execute function public.tg_log_event();
create trigger health_sleep_journal after insert on public.health_sleep for each row execute function public.tg_log_event();
create trigger health_sleep_journal_update after update on public.health_sleep for each row
  when (old.start_at is distinct from new.start_at or old.end_at is distinct from new.end_at
        or old.minutes is distinct from new.minutes or old.stages is distinct from new.stages)
  execute function public.tg_log_event();

-- History of the Shortcuts import (checklist marks «steps» / «sleep») → health tables.
insert into public.health_daily (user_id, local_day, source, steps, synced_at)
select user_id, local_day, 'shortcuts', round(value)::integer, marked_at
from public.checklist_state
where item_key = 'steps' and value is not null and source = 'import'
on conflict (user_id, local_day, source) do nothing;

-- The old import stored sleep on the evening's date; health_sleep keys a night by its wake-up day.
insert into public.health_sleep (user_id, night_of, source, minutes, synced_at)
select user_id, local_day + 1, 'shortcuts', round(value * 60)::integer, marked_at
from public.checklist_state
where item_key = 'sleep' and value is not null and source = 'import'
on conflict (user_id, night_of, source) do nothing;
