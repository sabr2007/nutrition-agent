-- Core schema for the nutrition agent ("Рядом").
-- Principles:
--  * every user-owned table has user_id + RLS (multi-user from day one);
--  * all timestamps are timestamptz (UTC); "day" = local_day computed from the
--    user's timezone and a configurable day boundary (default 04:00);
--  * edits never overwrite history: meals/body metrics/goals/memories/skills are
--    versioned (supersedes_id + is_current) and every write lands in `events`
--    (append-only journal) via triggers.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- array_to_string() is only STABLE; for text[] it is immutable in practice, and we
-- need it inside generated columns.
create or replace function public.tags_text(t text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select array_to_string(coalesce(t, '{}'::text[]), ' ')
$$;

create or replace function public.normalize_ru(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(translate(coalesce(t, ''), 'ёЁ', 'еЕ'))
$$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  timezone text not null default 'Asia/Almaty',
  day_boundary_minutes integer not null default 240
    check (day_boundary_minutes between 0 and 720),
  height_cm numeric(5, 1),
  sex text check (sex in ('male', 'female')),
  birth_year integer,
  locale text not null default 'ru',
  quiet_start time not null default '23:00',
  quiet_end time not null default '08:00',
  max_proactive_per_day integer not null default 10,
  min_minutes_between_proactive integer not null default 25,
  -- ISO weekday numbers (1 = Monday) and local times
  training jsonb not null default '{"days":[1,3,5],"start":"18:00","end":"19:30"}',
  dislikes text[] not null default '{}',
  budget_notes text,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.user_local_day(p_user uuid, p_ts timestamptz)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select ((p_ts at time zone coalesce(p.timezone, 'Asia/Almaty'))
          - make_interval(mins => coalesce(p.day_boundary_minutes, 240)))::date
  from (select 1) as one
  left join public.profiles p on p.user_id = p_user
$$;

create or replace function public.tg_set_local_day()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ts timestamptz;
begin
  if new.local_day is null then
    ts := coalesce((to_jsonb(new) ->> tg_argv[0])::timestamptz, now());
    new.local_day := public.user_local_day(new.user_id, ts);
  end if;
  return new;
end
$$;

create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Append-only event journal
-- ---------------------------------------------------------------------------

create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  entity text,
  entity_id uuid,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  source text not null default 'app',
  payload jsonb not null default '{}'
);
create index events_user_time on public.events (user_id, recorded_at desc);
create index events_entity on public.events (entity, entity_id);

create or replace function public.tg_log_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if new.user_id is null then
    return new; -- shared rows (built-in skills, base foods) are not user events
  end if;
  v := to_jsonb(new) - 'embedding' - 'tsv' - 'access_token_enc' - 'refresh_token_enc';
  insert into public.events (user_id, type, entity, entity_id, source, payload)
  values (
    new.user_id,
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce((v ->> 'id')::uuid, new.user_id),
    coalesce(nullif(current_setting('app.source', true), ''), 'db'),
    v
  );
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Goals (immutable versions)
-- ---------------------------------------------------------------------------

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null default 'phase' check (kind in ('challenge', 'phase')),
  starts_on date not null,
  ends_on date,
  kcal_min integer not null,
  kcal_max integer not null,
  kcal_floor integer not null default 1500 check (kcal_floor >= 1500),
  protein_min_g integer not null,
  protein_max_g integer,
  fat_min_g integer not null,
  fat_max_g integer,
  carbs_min_g integer,
  carbs_max_g integer,
  steps_min integer,
  steps_max integer,
  sleep_min_h numeric(3, 1),
  success_criteria text,
  notes text,
  supersedes_id uuid references public.goals (id),
  is_current boolean not null default true,
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  check (kcal_min >= kcal_floor and kcal_max >= kcal_min)
);
create index goals_user on public.goals (user_id, starts_on) where is_current;

-- ---------------------------------------------------------------------------
-- Foods (shared base + personal)
-- ---------------------------------------------------------------------------

create table public.foods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade, -- null = shared base
  source text not null,      -- usda_sr | usda_fndn | off | label | kz | custom | seed | nutrition5k
  source_ref text,
  name_ru text not null,
  name_en text,
  aliases text[] not null default '{}',
  brand text,
  barcode text,
  category text,
  state text not null default 'as_is' check (state in ('raw', 'cooked', 'dry', 'as_is')),
  kcal_100g numeric(7, 2) not null check (kcal_100g >= 0),
  protein_100g numeric(6, 2) not null default 0 check (protein_100g >= 0),
  fat_100g numeric(6, 2) not null default 0 check (fat_100g >= 0),
  carbs_100g numeric(6, 2) not null default 0 check (carbs_100g >= 0),
  fiber_100g numeric(6, 2),
  kcal_low_100g numeric(7, 2),
  kcal_high_100g numeric(7, 2),
  raw_food_id uuid references public.foods (id),
  yield_factor numeric(5, 3),  -- cooked weight / raw weight
  default_portion_g numeric(7, 1),
  portions jsonb not null default '[]',
  confidence text not null default 'high' check (confidence in ('high', 'medium', 'low')),
  notes text,
  search_text text not null default '',
  tsv tsvector,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index foods_base_barcode on public.foods (barcode)
  where barcode is not null and user_id is null;
create unique index foods_user_barcode on public.foods (user_id, barcode)
  where barcode is not null and user_id is not null;
create unique index foods_base_source_ref on public.foods (source, source_ref)
  where source_ref is not null and user_id is null;
create index foods_trgm on public.foods using gin (search_text extensions.gin_trgm_ops);
create index foods_tsv on public.foods using gin (tsv);
create index foods_user on public.foods (user_id);

create or replace function public.tg_foods_search()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_text := public.normalize_ru(
    new.name_ru || ' ' || coalesce(new.name_en, '') || ' ' ||
    array_to_string(new.aliases, ' ') || ' ' || coalesce(new.brand, ''));
  new.tsv :=
    setweight(to_tsvector('russian', public.normalize_ru(new.name_ru)), 'A') ||
    setweight(to_tsvector('russian', public.normalize_ru(array_to_string(new.aliases, ' '))), 'B') ||
    setweight(to_tsvector('english', coalesce(new.name_en, '')), 'C') ||
    to_tsvector('simple', coalesce(new.brand, ''));
  return new;
end
$$;
create trigger foods_search before insert or update on public.foods
  for each row execute function public.tg_foods_search();

-- Fuzzy food search (RLS applies: shared base + caller's own foods).
create or replace function public.search_foods(q text, lim integer default 12)
returns table (
  id uuid, user_id uuid, source text, name_ru text, name_en text, brand text,
  barcode text, category text, state text, kcal_100g numeric, protein_100g numeric,
  fat_100g numeric, carbs_100g numeric, kcal_low_100g numeric, kcal_high_100g numeric,
  raw_food_id uuid, yield_factor numeric, default_portion_g numeric, portions jsonb,
  confidence text, score real
)
language sql
stable
set search_path = public, extensions
as $$
  with qq as (
    select public.normalize_ru(trim(q)) as s,
           websearch_to_tsquery('russian', public.normalize_ru(trim(q))) as tq_ru,
           websearch_to_tsquery('english', trim(q)) as tq_en
  )
  select f.id, f.user_id, f.source, f.name_ru, f.name_en, f.brand, f.barcode, f.category,
         f.state, f.kcal_100g, f.protein_100g, f.fat_100g, f.carbs_100g, f.kcal_low_100g,
         f.kcal_high_100g, f.raw_food_id, f.yield_factor, f.default_portion_g, f.portions,
         f.confidence,
         (greatest(similarity(f.search_text, qq.s), word_similarity(qq.s, f.search_text))
           + ts_rank(f.tsv, qq.tq_ru) + ts_rank(f.tsv, qq.tq_en) * 0.5
           + case when f.user_id is not null then 0.15 else 0 end
           + case when public.normalize_ru(f.name_ru) = qq.s then 0.6 else 0 end
           + case when public.normalize_ru(f.name_ru) like qq.s || '%' then 0.2 else 0 end
         )::real as score
  from public.foods f, qq
  where f.archived_at is null
    and length(qq.s) > 0
    and (
      f.search_text % qq.s
      or qq.s <% f.search_text
      or f.search_text like '%' || qq.s || '%'
      or f.tsv @@ qq.tq_ru
      or f.tsv @@ qq.tq_en
    )
  order by score desc, f.name_ru
  limit greatest(1, least(lim, 50))
$$;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

create table public.meal_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text,
  name text not null,
  slot text not null,  -- breakfast | lunch | dinner | snack | shake | supplement | late
  default_time time,
  checklist_key text,
  training_day_only boolean not null default false,
  glyph text,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

create table public.meal_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.meal_templates (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  food_id uuid not null references public.foods (id),
  grams numeric(7, 1) not null check (grams > 0),
  optional boolean not null default false,
  note text,
  sort_order integer not null default 0
);
create index meal_template_items_t on public.meal_template_items (template_id);

-- ---------------------------------------------------------------------------
-- Media (raw inputs in private Storage)
-- ---------------------------------------------------------------------------

create table public.media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('photo', 'audio', 'body_photo')),
  bucket text not null default 'media',
  path text not null,
  mime text,
  bytes integer,
  width integer,
  height integer,
  duration_ms integer,
  sha256 text,
  created_at timestamptz not null default now()
);
create index media_user on public.media (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Recognition runs (photo / voice / text parsing) — full model output kept
-- ---------------------------------------------------------------------------

create table public.recognitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('photo', 'voice', 'text', 'barcode', 'scale')),
  media_ids uuid[] not null default '{}',
  input_text text,
  transcript text,
  hints jsonb not null default '{}',
  pipeline_version text not null,
  prompt_version text not null,
  runs jsonb not null default '[]',
  result jsonb,
  agreement numeric(4, 3),
  confidence numeric(4, 3),
  questions jsonb,
  answers jsonb,
  status text not null default 'done' check (status in ('pending', 'done', 'error')),
  error text,
  latency_ms integer,
  cost_usd numeric(10, 6),
  created_at timestamptz not null default now()
);
create index recognitions_user on public.recognitions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Meals (versioned) + items
-- ---------------------------------------------------------------------------

create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  root_id uuid,
  version integer not null default 1,
  supersedes_id uuid references public.meals (id),
  is_current boolean not null default true,
  status text not null default 'confirmed' check (status in ('draft', 'confirmed', 'deleted')),
  eaten_at timestamptz not null,
  logged_at timestamptz not null default now(),
  local_day date not null,
  slot text,
  title text,
  input_method text not null check (input_method in (
    'template', 'text', 'photo', 'voice', 'barcode', 'repeat', 'manual', 'agent', 'scale', 'import')),
  template_id uuid references public.meal_templates (id) on delete set null,
  recognition_id uuid references public.recognitions (id) on delete set null,
  confidence numeric(4, 3),
  is_labeled boolean not null default false,
  time_to_confirm_ms integer,
  kcal numeric(8, 1) not null default 0,
  protein_g numeric(7, 1) not null default 0,
  fat_g numeric(7, 1) not null default 0,
  carbs_g numeric(7, 1) not null default 0,
  note text,
  client_id text,
  created_at timestamptz not null default now()
);
create unique index meals_client_id on public.meals (user_id, client_id) where client_id is not null;
create index meals_day on public.meals (user_id, local_day) where is_current and status = 'confirmed';
create index meals_root on public.meals (root_id);

create or replace function public.tg_meals_root()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.root_id is null then
    new.root_id := new.id;
  end if;
  return new;
end
$$;
create trigger meals_root before insert on public.meals
  for each row execute function public.tg_meals_root();

create table public.meal_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  food_id uuid references public.foods (id) on delete set null,
  name text not null,
  grams numeric(7, 1) not null check (grams >= 0),
  state text,
  kcal numeric(8, 1) not null default 0,
  protein_g numeric(7, 1) not null default 0,
  fat_g numeric(7, 1) not null default 0,
  carbs_g numeric(7, 1) not null default 0,
  per100 jsonb,
  confidence numeric(4, 3),
  source text not null default 'user' check (source in (
    'model', 'user', 'template', 'scale', 'barcode', 'agent', 'repeat')),
  model_grams numeric(7, 1),
  model_label text,
  edited boolean not null default false,
  sort_order integer not null default 0
);
create index meal_items_meal on public.meal_items (meal_id);
create index meal_items_food on public.meal_items (user_id, food_id);

-- User corrections of model output (personal calibration + few-shot source)
create table public.meal_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  meal_id uuid references public.meals (id) on delete set null,
  recognition_id uuid references public.recognitions (id) on delete set null,
  kind text not null check (kind in ('grams', 'food', 'added', 'removed', 'state', 'answer')),
  item_label text,
  food_id_before uuid,
  food_id_after uuid,
  grams_before numeric(7, 1),
  grams_after numeric(7, 1),
  diff jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index meal_corrections_user on public.meal_corrections (user_id, created_at desc);

-- Atomic meal save: inserts a new version (or first version) with items.
-- p: { id?, supersedes_id?, eaten_at, slot, title, input_method, template_id?,
--      recognition_id?, confidence?, is_labeled?, time_to_confirm_ms?, note?, client_id?,
--      items: [{food_id?, name, grams, state?, kcal, protein_g, fat_g, carbs_g, per100?,
--               confidence?, source?, model_grams?, model_label?, edited?}] }
create or replace function public.save_meal(p jsonb)
returns public.meals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prev public.meals;
  m public.meals;
  existing public.meals;
  it jsonb;
  i integer := 0;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if p ? 'client_id' and p ->> 'client_id' is not null then
    select * into existing from public.meals
      where user_id = uid and client_id = p ->> 'client_id';
    if found then
      return existing; -- idempotent replay from offline outbox
    end if;
  end if;

  if p ? 'supersedes_id' and p ->> 'supersedes_id' is not null then
    select * into prev from public.meals
      where id = (p ->> 'supersedes_id')::uuid and user_id = uid and is_current
      for update;
    if not found then
      raise exception 'meal to edit not found or not current';
    end if;
    update public.meals set is_current = false where id = prev.id;
  end if;

  insert into public.meals (
    user_id, root_id, version, supersedes_id, status, eaten_at, slot, title, input_method,
    template_id, recognition_id, confidence, is_labeled, time_to_confirm_ms, note, client_id,
    local_day
  ) values (
    uid,
    prev.root_id,
    coalesce(prev.version, 0) + 1,
    prev.id,
    coalesce(p ->> 'status', 'confirmed'),
    coalesce((p ->> 'eaten_at')::timestamptz, prev.eaten_at, now()),
    coalesce(p ->> 'slot', prev.slot),
    coalesce(p ->> 'title', prev.title),
    coalesce(p ->> 'input_method', prev.input_method, 'manual'),
    coalesce((p ->> 'template_id')::uuid, prev.template_id),
    coalesce((p ->> 'recognition_id')::uuid, prev.recognition_id),
    coalesce((p ->> 'confidence')::numeric, prev.confidence),
    coalesce((p ->> 'is_labeled')::boolean, prev.is_labeled, false),
    (p ->> 'time_to_confirm_ms')::integer,
    coalesce(p ->> 'note', prev.note),
    p ->> 'client_id',
    public.user_local_day(uid, coalesce((p ->> 'eaten_at')::timestamptz, prev.eaten_at, now()))
  )
  returning * into m;

  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    insert into public.meal_items (
      meal_id, user_id, food_id, name, grams, state, kcal, protein_g, fat_g, carbs_g, per100,
      confidence, source, model_grams, model_label, edited, sort_order
    ) values (
      m.id, uid, (it ->> 'food_id')::uuid, it ->> 'name', (it ->> 'grams')::numeric,
      it ->> 'state',
      coalesce((it ->> 'kcal')::numeric, 0), coalesce((it ->> 'protein_g')::numeric, 0),
      coalesce((it ->> 'fat_g')::numeric, 0), coalesce((it ->> 'carbs_g')::numeric, 0),
      it -> 'per100', (it ->> 'confidence')::numeric, coalesce(it ->> 'source', 'user'),
      (it ->> 'model_grams')::numeric, it ->> 'model_label',
      coalesce((it ->> 'edited')::boolean, false), i
    );
    i := i + 1;
  end loop;

  update public.meals set
    kcal = coalesce((select sum(kcal) from public.meal_items where meal_id = m.id), 0),
    protein_g = coalesce((select sum(protein_g) from public.meal_items where meal_id = m.id), 0),
    fat_g = coalesce((select sum(fat_g) from public.meal_items where meal_id = m.id), 0),
    carbs_g = coalesce((select sum(carbs_g) from public.meal_items where meal_id = m.id), 0)
  where id = m.id
  returning * into m;

  return m;
end
$$;

-- Soft delete = new version with status 'deleted' (history kept).
create or replace function public.delete_meal(p_id uuid)
returns public.meals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  prev public.meals;
  m public.meals;
begin
  select * into prev from public.meals where id = p_id and user_id = uid and is_current for update;
  if not found then
    raise exception 'meal not found';
  end if;
  update public.meals set is_current = false where id = prev.id;
  insert into public.meals (
    user_id, root_id, version, supersedes_id, status, eaten_at, local_day, slot, title,
    input_method, template_id, recognition_id, confidence, is_labeled, kcal, protein_g,
    fat_g, carbs_g, note
  ) values (
    uid, prev.root_id, prev.version + 1, prev.id, 'deleted', prev.eaten_at, prev.local_day,
    prev.slot, prev.title, prev.input_method, prev.template_id, prev.recognition_id,
    prev.confidence, prev.is_labeled, prev.kcal, prev.protein_g, prev.fat_g, prev.carbs_g,
    prev.note
  ) returning * into m;
  return m;
end
$$;

-- ---------------------------------------------------------------------------
-- Checklists (append-only marks; latest mark per day/key wins)
-- ---------------------------------------------------------------------------

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  label text not null,
  kind text not null default 'bool' check (kind in ('bool', 'number')),
  unit text,
  target numeric,
  training_day_only boolean not null default false,
  due_time time,
  sort_order integer not null default 0,
  active boolean not null default true,
  unique (user_id, key)
);

create table public.checklist_marks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  local_day date not null,
  item_key text not null,
  done boolean not null,
  value numeric,
  source text not null default 'user' check (source in ('user', 'auto', 'agent', 'import')),
  marked_at timestamptz not null default now()
);
create index checklist_marks_day on public.checklist_marks (user_id, local_day, item_key, marked_at desc);

create view public.checklist_state with (security_invoker = true) as
  select distinct on (user_id, local_day, item_key)
    user_id, local_day, item_key, done, value, source, marked_at
  from public.checklist_marks
  order by user_id, local_day, item_key, marked_at desc;

-- ---------------------------------------------------------------------------
-- Body metrics, workouts, slips
-- ---------------------------------------------------------------------------

create table public.body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('weight', 'waist', 'body_fat', 'chest', 'hips', 'photo')),
  value numeric(6, 2),
  unit text,
  measured_at timestamptz not null default now(),
  local_day date not null,
  fasted boolean,
  media_id uuid references public.media (id) on delete set null,
  note text,
  supersedes_id uuid references public.body_metrics (id),
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create index body_metrics_user on public.body_metrics (user_id, kind, measured_at desc) where is_current;
create trigger body_metrics_day before insert on public.body_metrics
  for each row execute function public.tg_set_local_day('measured_at');

create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  local_day date not null,
  started_at timestamptz,
  ended_at timestamptz,
  kind text not null default 'gym',
  source text not null default 'user' check (source in ('user', 'schedule', 'agent', 'import')),
  note text,
  created_at timestamptz not null default now()
);
create index workouts_user on public.workouts (user_id, local_day);
create trigger workouts_day before insert on public.workouts
  for each row execute function public.tg_set_local_day('started_at');

create table public.slips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  local_day date not null,
  meal_id uuid references public.meals (id) on delete set null,
  trigger text,
  location text,
  feeling text,
  description text,
  plan_next_time text,
  created_at timestamptz not null default now()
);
create index slips_user on public.slips (user_id, occurred_at desc);
create trigger slips_day before insert on public.slips
  for each row execute function public.tg_set_local_day('occurred_at');

-- ---------------------------------------------------------------------------
-- Agent: messages, runs (traces), LLM call log
-- ---------------------------------------------------------------------------

create table public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread text not null default 'main',
  role text not null check (role in ('user', 'assistant', 'system')),
  kind text not null default 'chat' check (kind in ('chat', 'proactive', 'summary', 'event')),
  parts jsonb not null default '[]',
  text text not null default '',
  run_id uuid,
  notification_id uuid,
  meta jsonb not null default '{}',
  tsv tsvector generated always as (to_tsvector('russian', text)) stored,
  created_at timestamptz not null default now()
);
create index agent_messages_thread on public.agent_messages (user_id, thread, created_at desc);
create index agent_messages_tsv on public.agent_messages using gin (tsv);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trigger text not null check (trigger in ('chat', 'cron', 'event', 'rule', 'eval', 'system')),
  skill_key text,
  status text not null default 'running' check (status in ('running', 'ok', 'error', 'skipped')),
  decision text,
  provider text,
  model text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  latency_ms integer,
  steps integer,
  tool_calls jsonb not null default '[]',
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10, 6),
  input jsonb,
  output_text text,
  error text
);
create index agent_runs_user on public.agent_runs (user_id, started_at desc);

create table public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  run_id uuid,
  recognition_id uuid,
  purpose text not null,
  provider text not null,
  model text not null,
  status text not null check (status in ('ok', 'error')),
  error_code text,
  error text,
  fallback_from text,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10, 6),
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index llm_calls_user on public.llm_calls (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Memory (profile facts, patterns, episodic summaries) and skills
-- ---------------------------------------------------------------------------

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in (
    'fact', 'preference', 'pattern', 'routine', 'episode', 'day_summary', 'week_summary')),
  content text not null,
  tags text[] not null default '{}',
  importance smallint not null default 3 check (importance between 1 and 5),
  status text not null default 'active' check (status in ('proposed', 'active', 'archived', 'rejected')),
  source text not null default 'agent' check (source in ('agent', 'user', 'system')),
  pinned boolean not null default false,
  ref_day date,
  supersedes_id uuid references public.memories (id),
  embedding extensions.vector(1536),
  tsv tsvector generated always as (
    to_tsvector('russian', content || ' ' || public.tags_text(tags))) stored,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memories_user on public.memories (user_id, status, kind);
create index memories_tsv on public.memories using gin (tsv);
create trigger memories_touch before update on public.memories
  for each row execute function public.tg_touch_updated_at();

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade, -- null = built-in
  key text not null,
  version integer not null default 1,
  title text not null,
  description text not null,
  body text not null,
  tools text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'draft', 'archived')),
  created_by text not null default 'system' check (created_by in ('system', 'agent', 'user')),
  change_note text,
  supersedes_id uuid references public.skills (id),
  is_current boolean not null default true,
  usage_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index skills_current on public.skills (
  coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), key) where is_current;

-- ---------------------------------------------------------------------------
-- Reminders: rules as data, notifications + reactions, push subscriptions
-- ---------------------------------------------------------------------------

create table public.reminder_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  title text not null,
  kind text not null check (kind in ('schedule', 'context', 'agent')),
  enabled boolean not null default true,
  at_time time,
  window_minutes integer not null default 25,
  days integer[],
  training_days_only boolean not null default false,
  condition jsonb not null default '{}',
  template text not null,
  compose_with_llm boolean not null default false,
  skill_key text,
  priority smallint not null default 3 check (priority between 1 and 5),
  cooldown_minutes integer not null default 120,
  once_per_day boolean not null default true,
  deep_link text not null default '/',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
create trigger reminder_rules_touch before update on public.reminder_rules
  for each row execute function public.tg_touch_updated_at();

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  rule_key text,
  local_day date,
  title text not null,
  body text not null,
  deep_link text,
  status text not null default 'pending' check (status in (
    'pending', 'sent', 'failed', 'suppressed', 'snoozed', 'cancelled')),
  suppression_reason text,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  delivered_count integer not null default 0,
  opened_at timestamptz,
  snoozed_until timestamptz,
  dismissed_at timestamptz,
  acted_at timestamptz,
  reaction text check (reaction in ('opened', 'snoozed', 'done', 'dismissed', 'ignored')),
  run_id uuid,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index notifications_user on public.notifications (user_id, created_at desc);
create index notifications_pending on public.notifications (status, scheduled_for) where status = 'pending';

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0,
  disabled_at timestamptz
);

-- LLM provider connections (e.g. Sign in with ChatGPT). Tokens are encrypted by
-- the app (AES-256-GCM, APP_ENCRYPTION_KEY) and never readable from the client.
create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error')),
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  scope text,
  weekly_budget_usd numeric(8, 2),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- P1: recipes, shopping lists
-- ---------------------------------------------------------------------------

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body jsonb not null,
  kcal numeric(8, 1),
  protein_g numeric(7, 1),
  fat_g numeric(7, 1),
  carbs_g numeric(7, 1),
  tags text[] not null default '{}',
  source text not null default 'agent',
  favorite boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  days integer not null,
  items jsonb not null,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Derived views (security_invoker => RLS of the caller applies)
-- ---------------------------------------------------------------------------

create view public.day_totals with (security_invoker = true) as
  select user_id,
         local_day,
         count(*) filter (where coalesce(slot, '') <> 'supplement') as meals_count,
         round(sum(kcal), 1) as kcal,
         round(sum(protein_g), 1) as protein_g,
         round(sum(fat_g), 1) as fat_g,
         round(sum(carbs_g), 1) as carbs_g,
         min(eaten_at) as first_meal_at,
         max(eaten_at) as last_meal_at
  from public.meals
  where is_current and status = 'confirmed'
  group by user_id, local_day;

create view public.weight_daily with (security_invoker = true) as
  with daily as (
    select distinct on (user_id, local_day) user_id, local_day, value
    from public.body_metrics
    where kind = 'weight' and is_current
    order by user_id, local_day, measured_at asc
  )
  select d.user_id, d.local_day, d.value as weight,
         round(avg(d2.value), 2) as avg7,
         count(d2.value) as n7
  from daily d
  join daily d2 on d2.user_id = d.user_id
    and d2.local_day between d.local_day - 6 and d.local_day
  group by d.user_id, d.local_day, d.value;

-- ---------------------------------------------------------------------------
-- Event journal triggers
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'goals', 'meals', 'meal_templates', 'checklist_marks', 'body_metrics',
    'workouts', 'slips', 'memories', 'skills', 'reminder_rules', 'recognitions',
    'meal_corrections', 'notifications', 'checklist_items', 'recipes', 'shopping_lists'
  ] loop
    execute format(
      'create trigger %I after insert or update on public.%I for each row execute function public.tg_log_event()',
      t || '_journal', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  -- full CRUD on own rows
  foreach t in array array[
    'profiles', 'goals', 'meal_templates', 'meal_template_items', 'media', 'recognitions',
    'meals', 'meal_items', 'meal_corrections', 'checklist_items', 'checklist_marks',
    'body_metrics', 'workouts', 'slips', 'agent_messages', 'agent_runs', 'llm_calls',
    'memories', 'reminder_rules', 'notifications', 'push_subscriptions', 'recipes',
    'shopping_lists'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))',
      t || '_delete_own', t);
  end loop;
end
$$;

-- events: append-only for users (select + insert, no update/delete)
alter table public.events enable row level security;
create policy events_select_own on public.events for select to authenticated
  using (user_id = (select auth.uid()));
create policy events_insert_own on public.events for insert to authenticated
  with check (user_id = (select auth.uid()));
revoke update, delete, truncate on public.events from anon, authenticated;

-- foods & skills: shared rows (user_id is null) are readable, own rows writable
alter table public.foods enable row level security;
create policy foods_select on public.foods for select to authenticated
  using (user_id is null or user_id = (select auth.uid()));
create policy foods_insert_own on public.foods for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy foods_update_own on public.foods for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy foods_delete_own on public.foods for delete to authenticated
  using (user_id = (select auth.uid()));

alter table public.skills enable row level security;
create policy skills_select on public.skills for select to authenticated
  using (user_id is null or user_id = (select auth.uid()));
create policy skills_insert_own on public.skills for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy skills_update_own on public.skills for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- provider tokens: server (service role) only
alter table public.provider_connections enable row level security;

-- anon gets nothing
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon;
