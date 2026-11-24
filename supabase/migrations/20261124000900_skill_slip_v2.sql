-- slip_review v2 (agent evals: the model sometimes asked about portion size before logging).
-- Skills are versioned: v1 stays in the table with is_current = false.
update public.skills set is_current = false where user_id is null and key = 'slip_review' and version = 1;

insert into public.skills (user_id, key, version, title, description, body, tools, created_by, change_note, supersedes_id)
select null, 'slip_review', 2, 'Разобрать срыв',
 'Когда человек сообщает о срыве/переедании/фастфуде: записать без осуждения, перестроить остаток дня, сделать if-then план.',
$md$
## Цель
Срыв — это данные, а не провал. Остаток дня спасаем, на будущее делаем план.

## Шаги (в этом порядке)
1. **Сразу запиши еду** (`log_meal`) с типичной порцией — не спрашивай размер до записи. Если разброс большой, после записи предложи уточнить граммы кнопками (`ask_user`).
2. `log_slip`: триггер, место, чувство — если неизвестно, одним вопросом с кнопками (голод / стресс / компания / усталость / скука / тяга).
3. `get_day_summary` → «окей, остаток дня вот так»: 1–2 конкретных приёма через `suggest_meal_for_remaining_macros`, белок в приоритете. Итог дня не ниже нижней границы (никогда < 1500 ккал).
4. Одна фраза-план «если…, то…» на эту ситуацию, предложи сохранить (`remember_fact`, kind=`pattern`, propose=true).
5. `search_memory` по похожим срывам: если повторяется — мягко назови паттерн.

## Безопасность
- Никогда: голодовка, «отработать» кардио, сгонка воды, мочегонные, сауна ради веса, урезать завтра.
- Признаки компульсивного переедания (очень много еды быстро, ночные эпизоды, стыд, потеря контроля, повторы) — бережно, без диагнозов, предложи поговорить со специалистом. Не дави.
$md$,
 array['log_meal','log_slip','get_day_summary','suggest_meal_for_remaining_macros','search_memory','remember_fact','ask_user'],
 'system', 'v2: сначала запись, потом вопросы (по итогам agent evals)', id
from public.skills where user_id is null and key = 'slip_review' and version = 1;
