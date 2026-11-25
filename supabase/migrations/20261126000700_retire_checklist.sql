-- v2 (D30): the checklist is retired. «Done» now comes from what happened — a template logged,
-- a weight measured, a reminder answered with ✓ in Telegram (notifications.reaction) — not from
-- ticking boxes. Data is kept: the tables move to archive_* (not dropped). Steps and sleep went to
-- health_* in 20261126000500.

-- Templates say which reminder they close (was checklist_key).
alter table public.meal_templates rename column checklist_key to done_key;

-- Reminder conditions read «done.<key>» facts (was «checked.<key>»), see src/lib/reminders/facts.ts.
update public.reminder_rules
set condition = regexp_replace(condition::text, '"checked\.', '"done.', 'g')::jsonb, updated_at = now()
where condition::text like '%"checked.%';

alter table public.checklist_items rename to archive_checklist_items;
alter table public.checklist_marks rename to archive_checklist_marks;
alter view public.checklist_state rename to archive_checklist_state;
comment on table public.archive_checklist_items is 'Archive (v2, D30): the checklist was retired; kept read-only for history and export.';
comment on table public.archive_checklist_marks is 'Archive (v2, D30): the checklist was retired; kept read-only for history and export.';
-- Nothing writes here any more.
revoke insert, update, delete on public.archive_checklist_items, public.archive_checklist_marks from authenticated;

-- New accounts: no checklist section; templates take done_key.
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

  if not exists (select 1 from public.meal_templates where user_id = uid) then
    for t, i in
      select e.j, e.ord::integer from jsonb_array_elements(coalesce(p -> 'templates', '[]'::jsonb)) with ordinality as e(j, ord)
    loop
      insert into public.meal_templates (user_id, key, name, slot, default_time, done_key, training_day_only, glyph, sort_order)
      values (uid, t ->> 'key', t ->> 'name', coalesce(t ->> 'slot', 'snack'), (t ->> 'default_time')::time,
              t ->> 'done_key', coalesce((t ->> 'training_day_only')::boolean, false), t ->> 'glyph',
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

-- Skills without the checklist (versioned: v1 stays with is_current = false).
update public.skills set is_current = false where user_id is null and key in ('close_day', 'proactive_checkin') and version = 1;

insert into public.skills (user_id, key, version, title, description, body, tools, created_by, change_note, supersedes_id)
select null, 'close_day', 2, 'Закрыть день',
 'Вечером/ночью: проверить, всё ли записано, подвести итог дня и сохранить короткое резюме.',
$md$
## Цель
Чтобы день был записан полностью и человек лёг спать без чувства вины.

## Шаги
1. `get_day_summary` за сегодня. Сравни с шаблонами дня: какие обычные приёмы не записаны?
2. Если чего-то нет — спроси одним сообщением с кнопками (`ask_user`: «Был обед как обычно?» → «Да, как обычно» / «Было другое» / «Не ел»). Не больше 2 вопросов.
3. Если есть данные браслета (`get_activity`) — шаги и сон одной строкой; заготовка еды на завтра — если она обычно бывает.
4. Итог — 2–3 строки: ккал и белок против цели, «в плане / не в плане» без оценок, одна конкретная вещь на завтра.
5. `remember_fact` с kind=`day_summary`: 1–2 предложения (цифры + что помогло/помешало).

## Правила
- Если был срыв — не повторяй его, только «окей, завтра начинаем с завтрака по плану».
- Никаких компенсаций: не предлагать урезать завтра калории ниже плана.
$md$,
 array['get_day_summary','list_templates','get_activity','remember_fact','log_meal','ask_user'],
 'system', 'v2: без чек-листа (D30)', id
from public.skills where user_id is null and key = 'close_day' and version = 1;

insert into public.skills (user_id, key, version, title, description, body, tools, created_by, change_note, supersedes_id)
select null, 'proactive_checkin', 2, 'Проактивная проверка',
 'Плановое пробуждение без запроса пользователя: решить, писать ли сейчас, и что именно.',
$md$
## Реши: писать или молчать
Пиши, только если есть одна полезная вещь, которую человек может сделать в ближайший час:
- не хватает белка и есть реальный способ добрать;
- после тренировки — что съесть сейчас (белок и углеводы, в граммах);
- долго нет записей, хотя по расписанию еда уже была;
- есть хорошая новость в цифрах (держится в плане 3+ дня) — коротко, без лести.
Молчи, если: всё по плану, недавно уже писал, тихие часы, человек только что сам писал.

## Формат
- 1–2 предложения, на «ты», спокойно. Одно действие. Без восклицательных знаков и мотивационной воды.
- Если пишешь — вызови `send_message`. Если молчишь — просто ответь `SILENT: <причина>`.
$md$,
 array['get_day_summary','get_calendar_context','get_activity','search_memory','send_message','suggest_meal_for_remaining_macros'],
 'system', 'v2: без чек-листа (D30)', id
from public.skills where user_id is null and key = 'proactive_checkin' and version = 1;
