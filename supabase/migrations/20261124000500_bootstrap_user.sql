-- Per-user defaults, seeded once when the owner account is created.
--
-- Everything personal (body stats, schedule, goals, checklist, meal templates, reminder
-- rules, starter memories) comes from the caller in `p`: scripts/create-user.ts reads the
-- gitignored scripts/personal-seed.json, and plan sections it lacks fall back to the
-- generic example in scripts/personal-seed.example.json. Nothing personal lives in the
-- repository. Re-running is safe: existing rows are never overwritten.
-- Callable only with the service role.

create or replace function public.food_ref(p_source text, p_ref text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select id from public.foods
  where user_id is null and source = p_source and source_ref = p_ref
  limit 1
$$;

create or replace function public.bootstrap_user(uid uuid, p jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t jsonb;
  it jsonb;
  m jsonb;
  t_id uuid;
  f_id uuid;
  i integer;
  j integer;
begin
  perform set_config('app.source', 'bootstrap', true);

  -- Profile (defaults mirror the column defaults in the core migration) -------------
  insert into public.profiles (user_id, display_name, height_cm, sex, birth_year, dislikes, budget_notes,
                               timezone, day_boundary_minutes, quiet_start, quiet_end, training)
  values (
    uid,
    coalesce(p ->> 'display_name', 'Друг'),
    (p ->> 'height_cm')::numeric,
    p ->> 'sex',
    (p ->> 'birth_year')::integer,
    coalesce(array(select jsonb_array_elements_text(p -> 'dislikes')), '{}'),
    p ->> 'budget_notes',
    coalesce(p ->> 'timezone', 'Asia/Almaty'),
    coalesce((p ->> 'day_boundary_minutes')::integer, 240),
    coalesce((p ->> 'quiet_start')::time, '23:00'),
    coalesce((p ->> 'quiet_end')::time, '08:00'),
    coalesce(p -> 'training', '{"days":[1,3,5],"start":"18:00","end":"19:30"}'::jsonb)
  )
  on conflict (user_id) do nothing;

  -- Goals (the 1500 kcal floor is enforced by check constraints on public.goals) -----
  if not exists (select 1 from public.goals where user_id = uid) then
    insert into public.goals (user_id, name, kind, starts_on, ends_on, kcal_min, kcal_max, kcal_floor,
      protein_min_g, protein_max_g, fat_min_g, fat_max_g, carbs_min_g, carbs_max_g,
      steps_min, steps_max, sleep_min_h, success_criteria, notes, created_by)
    select uid, g ->> 'name', coalesce(g ->> 'kind', 'phase'),
           coalesce((g ->> 'starts_on')::date, current_date), (g ->> 'ends_on')::date,
           (g ->> 'kcal_min')::integer, (g ->> 'kcal_max')::integer,
           greatest(coalesce((g ->> 'kcal_floor')::integer, 1500), 1500),
           (g ->> 'protein_min_g')::integer, (g ->> 'protein_max_g')::integer,
           (g ->> 'fat_min_g')::integer, (g ->> 'fat_max_g')::integer,
           (g ->> 'carbs_min_g')::integer, (g ->> 'carbs_max_g')::integer,
           (g ->> 'steps_min')::integer, (g ->> 'steps_max')::integer,
           (g ->> 'sleep_min_h')::numeric, g ->> 'success_criteria', g ->> 'notes', 'system'
    from jsonb_array_elements(coalesce(p -> 'goals', '[]'::jsonb)) as g;
  end if;

  -- Checklist -------------------------------------------------------------------------
  insert into public.checklist_items (user_id, key, label, kind, unit, target, training_day_only, due_time, sort_order)
  select uid, e.j ->> 'key', e.j ->> 'label', coalesce(e.j ->> 'kind', 'bool'), e.j ->> 'unit',
         (e.j ->> 'target')::numeric, coalesce((e.j ->> 'training_day_only')::boolean, false),
         (e.j ->> 'due_time')::time, coalesce((e.j ->> 'sort_order')::integer, e.ord::integer * 10)
  from jsonb_array_elements(coalesce(p -> 'checklist', '[]'::jsonb)) with ordinality as e(j, ord)
  on conflict (user_id, key) do nothing;

  -- Meal templates (items reference base foods by source + source_ref) ----------------
  if not exists (select 1 from public.meal_templates where user_id = uid) then
    for t, i in
      select e.j, e.ord::integer from jsonb_array_elements(coalesce(p -> 'templates', '[]'::jsonb)) with ordinality as e(j, ord)
    loop
      insert into public.meal_templates (user_id, key, name, slot, default_time, checklist_key, training_day_only, glyph, sort_order)
      values (uid, t ->> 'key', t ->> 'name', coalesce(t ->> 'slot', 'snack'), (t ->> 'default_time')::time,
              t ->> 'checklist_key', coalesce((t ->> 'training_day_only')::boolean, false), t ->> 'glyph',
              coalesce((t ->> 'sort_order')::integer, i * 10))
      returning id into t_id;

      for it, j in
        select e.j, e.ord::integer from jsonb_array_elements(coalesce(t -> 'items', '[]'::jsonb)) with ordinality as e(j, ord)
      loop
        f_id := public.food_ref(it ->> 'source', it ->> 'ref');
        if f_id is null then
          raise exception 'bootstrap_user: food %/% (template %) not found', it ->> 'source', it ->> 'ref', t ->> 'key';
        end if;
        insert into public.meal_template_items (template_id, user_id, food_id, grams, note, sort_order)
        values (t_id, uid, f_id, (it ->> 'grams')::numeric, it ->> 'note', j - 1);
      end loop;
    end loop;
  end if;

  -- Reminder rules (data, not code). Conditions use the DSL in src/lib/reminders/dsl.ts -
  insert into public.reminder_rules (user_id, key, title, kind, at_time, window_minutes, days, training_days_only,
      condition, template, compose_with_llm, skill_key, priority, cooldown_minutes, once_per_day, deep_link, sort_order)
  select uid, e.j ->> 'key', e.j ->> 'title', e.j ->> 'kind', (e.j ->> 'at_time')::time,
         coalesce((e.j ->> 'window_minutes')::integer, 25),
         case when jsonb_typeof(e.j -> 'days') = 'array'
              then array(select jsonb_array_elements_text(e.j -> 'days'))::integer[] end,
         coalesce((e.j ->> 'training_days_only')::boolean, false),
         coalesce(e.j -> 'condition', '{}'::jsonb), e.j ->> 'template',
         coalesce((e.j ->> 'compose_with_llm')::boolean, false), e.j ->> 'skill_key',
         coalesce((e.j ->> 'priority')::smallint, 3), coalesce((e.j ->> 'cooldown_minutes')::integer, 120),
         coalesce((e.j ->> 'once_per_day')::boolean, true), coalesce(e.j ->> 'deep_link', '/'),
         coalesce((e.j ->> 'sort_order')::integer, e.ord::integer * 10)
  from jsonb_array_elements(coalesce(p -> 'reminders', '[]'::jsonb)) with ordinality as e(j, ord)
  on conflict (user_id, key) do nothing;

  -- Starter memories: personal health context must never live in the repository -------
  if not exists (select 1 from public.memories where user_id = uid) then
    for m in select * from jsonb_array_elements(coalesce(p -> 'memories', '[]'::jsonb)) loop
      insert into public.memories (user_id, kind, content, tags, importance, status, source, pinned)
      values (uid, coalesce(m ->> 'kind', 'fact'), m ->> 'content',
              coalesce(array(select jsonb_array_elements_text(m -> 'tags')), '{}'),
              coalesce((m ->> 'importance')::smallint, 4), 'active', 'user',
              coalesce((m ->> 'pinned')::boolean, true));
    end loop;
  end if;
end
$$;

revoke execute on function public.bootstrap_user(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.bootstrap_user(uuid, jsonb) to service_role;
