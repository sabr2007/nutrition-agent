-- v2 (D29, revises D12): proactive messages go to Telegram with reaction buttons, new limits and rules.
--  * Limits: the agent's own messages — up to profiles.max_proactive_per_day (default 6), at least
--    90 minutes apart. The old defaults (10 / 25 — never chosen by hand) move to the new ones.
--  * Reactions from the buttons: ✓ Сделал (done), ⏰ 15 мин (snoozed), 🔕 Не сегодня (not_today),
--    and the «long without food» question: will_log / not_eaten.
--  * New default rules: morning, protein by 15:00, steps by 18:00, after a tracked workout,
--    5 hours without food. Times come from the profile (quiet hours) or the day, not from here.

alter table public.profiles alter column max_proactive_per_day set default 6;
alter table public.profiles alter column min_minutes_between_proactive set default 90;
update public.profiles set max_proactive_per_day = 6 where max_proactive_per_day = 10;
update public.profiles set min_minutes_between_proactive = 90 where min_minutes_between_proactive = 25;

alter table public.notifications drop constraint if exists notifications_reaction_check;
alter table public.notifications add constraint notifications_reaction_check
  check (reaction in ('opened', 'snoozed', 'done', 'dismissed', 'ignored', 'not_today', 'will_log', 'not_eaten'));
alter table public.notifications add column if not exists channel text check (channel in ('telegram', 'push', 'app'));
alter table public.notifications add column if not exists tg_message_id bigint;
create index if not exists notifications_user_day on public.notifications (user_id, local_day);

create or replace function public.ensure_extra_rules(uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.reminder_rules (user_id, key, title, kind, at_time, window_minutes, days, condition, template,
      compose_with_llm, skill_key, priority, cooldown_minutes, once_per_day, deep_link, sort_order) values
    (uid, 'weekly_review', 'Недельный разбор', 'agent', '13:00', 90, array[1], '{}',
     'Неделя закончилась — короткий разбор: вес в среднем за 7 дней, дни в плане, белок и одна цель на неделю.',
     true, 'weekly_review', 3, 600, true, '/report', 120),
    -- After the sleep ends (Google Health); without it — 15–90 minutes after the quiet hours.
    (uid, 'morning', 'Утро', 'agent', null, 0, null,
     '{"any": [{"fact": "minutes_since_wake", "op": "between", "value": [15, 120]},
               {"all": [{"fact": "minutes_since_wake", "op": "is_null"}, {"fact": "minutes_since_quiet_end", "op": "between", "value": [15, 90]}]}]}',
     'Утро: как спал (если есть данные), план на день и цель по белку — коротко.',
     true, 'proactive_checkin', 1, 600, true, '/', 5),
    (uid, 'protein_15', 'Белок к 15:00', 'agent', '15:00', 90, null,
     '{"fact": "protein_pct", "op": "lt", "value": 40}',
     'К 15:00 белка меньше 40% нормы: два варианта добора в граммах с кнопками «Записать».',
     true, 'whats_to_eat_now', 2, 600, true, '/', 45),
    (uid, 'steps_18', 'Шаги к 18:00', 'context', '18:00', 90, null,
     '{"all": [{"fact": "steps", "op": "not_null"}, {"fact": "steps_pct", "op": "lt", "value": 50}]}',
     'Шагов пока {steps} из {steps_goal}. До цели {steps_left} — это около {walk_minutes} мин ходьбы, можно частями.',
     false, null, 3, 600, true, '/', 75),
    (uid, 'workout_done', 'После тренировки', 'agent', null, 0, null,
     '{"fact": "minutes_since_tracked_workout_end", "op": "between", "value": [10, 60]}',
     'Тренировка закончилась: пересчитай остаток дня и скажи, что съесть сейчас — белок и углеводы, в граммах.',
     true, 'whats_to_eat_now', 1, 600, true, '/', 76),
    (uid, 'no_food_5h', 'Долго без еды', 'context', null, 0, null,
     '{"fact": "minutes_since_food", "op": "gte", "value": 300}',
     'Больше пяти часов без записей еды. Ел что-нибудь?',
     false, null, 2, 300, false, '/', 77)
  on conflict (user_id, key) do nothing;
end
$$;

revoke execute on function public.ensure_extra_rules(uuid) from public, anon, authenticated;
grant execute on function public.ensure_extra_rules(uuid) to service_role;

do $$
declare r record;
begin
  for r in select user_id from public.profiles loop
    perform public.ensure_extra_rules(r.user_id);
  end loop;
end
$$;

-- The evening check-in becomes the day's result with one takeaway (only where it is still the default).
update public.reminder_rules
set template = 'Вечер: итог дня цифрами и один вывод на завтра.', updated_at = now()
where key = 'evening_checkin' and template = 'Как день? Если что-то не записано — скажи, добавлю.';
