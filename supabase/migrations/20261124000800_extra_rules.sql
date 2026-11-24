-- Additional default reminder rules added after v1 bootstrap (idempotent per user).
create or replace function public.ensure_extra_rules(uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.reminder_rules (user_id, key, title, kind, at_time, window_minutes, days, condition, template,
      compose_with_llm, skill_key, priority, cooldown_minutes, deep_link, sort_order) values
    (uid, 'weekly_review', 'Недельный разбор', 'agent', '13:00', 90, array[1], '{}',
     'Неделя закончилась — короткий разбор: вес в среднем за 7 дней, дни в плане, белок и одна цель на неделю.',
     true, 'weekly_review', 3, 600, '/report', 120)
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
