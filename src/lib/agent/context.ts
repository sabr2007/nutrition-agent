import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DaySummary } from '@/lib/data/day';
import type { Profile } from '@/lib/data/profile';
import { localParts } from '@/lib/nutrition/day';

export const AGENT_PROMPT_VERSION = 'agent-v1';

type MemoryRow = { id: string; kind: string; content: string; pinned: boolean; importance: number; status: string };
type SkillRow = { key: string; title: string; description: string; user_id: string | null; version: number };

const WEEKDAY = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

export async function loadMemory(sb: SupabaseClient, userId: string, query?: string) {
  const pinnedQ = sb.from('memories').select('id, kind, content, pinned, importance, status').eq('user_id', userId)
    .eq('status', 'active').or('pinned.eq.true,importance.gte.5').order('importance', { ascending: false }).limit(20);
  const recentSummaries = sb.from('memories').select('id, kind, content, pinned, importance, status, ref_day').eq('user_id', userId)
    .eq('status', 'active').in('kind', ['day_summary', 'week_summary']).order('created_at', { ascending: false }).limit(3);
  const patterns = sb.from('memories').select('id, kind, content, pinned, importance, status').eq('user_id', userId)
    .eq('status', 'active').in('kind', ['pattern', 'routine', 'preference']).eq('pinned', false).order('updated_at', { ascending: false }).limit(8);
  const relevant = query && query.trim().length > 2
    ? sb.from('memories').select('id, kind, content, pinned, importance, status').eq('user_id', userId).eq('status', 'active')
      .textSearch('tsv', query.split(/\s+/).filter((w) => w.length > 3).slice(0, 6).join(' | ') || query, { config: 'russian' }).limit(6)
    : null;
  const [p, s, pt, r] = await Promise.all([pinnedQ, recentSummaries, patterns, relevant ?? Promise.resolve({ data: [] })]);
  const seen = new Set<string>();
  const uniq = (rows: MemoryRow[] | null | undefined) => (rows ?? []).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  return {
    pinned: uniq(p.data as MemoryRow[]),
    summaries: uniq(s.data as MemoryRow[]),
    patterns: uniq(pt.data as MemoryRow[]),
    relevant: uniq(r.data as MemoryRow[]),
  };
}

export async function loadSkillsIndex(sb: SupabaseClient, userId: string): Promise<SkillRow[]> {
  const { data } = await sb.from('skills').select('key, title, description, user_id, version').eq('is_current', true).eq('status', 'active')
    .or(`user_id.is.null,user_id.eq.${userId}`);
  const byKey = new Map<string, SkillRow>();
  for (const s of (data ?? []) as SkillRow[]) {
    const prev = byKey.get(s.key);
    if (!prev || (s.user_id && !prev.user_id)) byKey.set(s.key, s); // personal fork wins
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function daySnapshot(s: DaySummary): string {
  const lines: string[] = [];
  if (s.goal) {
    lines.push(`- Цель «${s.goal.name}»: ${s.goal.kcal_min}–${s.goal.kcal_max} ккал (никогда < ${s.goal.kcal_floor}), белок ${s.goal.protein_min_g}–${s.goal.protein_max_g ?? '…'} г, жиры ${s.goal.fat_min_g}–${s.goal.fat_max_g ?? '…'} г, углеводы ${s.goal.carbs_min_g ?? '…'}–${s.goal.carbs_max_g ?? '…'} г.`);
    if (s.goal.success_criteria) lines.push(`- Критерий успеха: ${s.goal.success_criteria}.`);
  }
  lines.push(`- Съедено за день: ${s.totals.kcal} ккал, белок ${s.totals.protein_g} г, жиры ${s.totals.fat_g} г, углеводы ${s.totals.carbs_g} г; приёмов пищи: ${s.totals.meals_count}.`);
  if (s.remaining) lines.push(`- До нижней границы белка: ${Math.max(0, s.remaining.protein_to_min)} г; до верхней границы калорий: ${s.remaining.kcal_to_max} ккал.`);
  if (s.meals.length) lines.push(`- Записано: ${s.meals.map((m) => `${localParts(new Date(m.eaten_at), s.profile.timezone).hhmm} ${m.title ?? m.slot ?? 'приём'} (${Math.round(m.kcal)} ккал)`).join('; ')}.`);
  const done = s.checklist.filter((c) => c.done).map((c) => c.label);
  const todo = s.checklist.filter((c) => !c.done).map((c) => (c.due_time ? `${c.label} (${c.due_time})` : c.label));
  lines.push(`- Чек-лист: сделано — ${done.join(', ') || 'ничего'}; не сделано — ${todo.join(', ') || 'всё сделано'}.`);
  if (s.challengeDay) lines.push(`- Челлендж: день ${s.challengeDay.n} из ${s.challengeDay.of}.`);
  return lines.join('\n');
}

export type PromptInput = {
  profile: Profile;
  summary: DaySummary;
  memory: Awaited<ReturnType<typeof loadMemory>>;
  skills: SkillRow[];
  mode: 'chat' | 'proactive';
  proactive?: { reason: string; ruleKey?: string | null; sentToday: number; lastSentAt?: string | null; template?: string | null };
  activeSkill?: { key: string; body: string } | null;
  safety?: { binge: boolean; reason: string | null };
  now?: Date;
  foodReport?: boolean;
};

export function buildSystemPrompt(i: PromptInput): string {
  const now = localParts(i.now ?? new Date(), i.profile.timezone);
  const floor = i.summary.goal?.kcal_floor ?? 1500;
  const name = i.profile.display_name ?? 'друг';
  const mem = (rows: MemoryRow[]) => rows.map((m) => `- [${m.kind}${m.status === 'proposed' ? ', не подтверждено' : ''}] ${m.content}`).join('\n');

  const base = `Ты — «Рядом», личный нутри-коуч и спокойный наставник для ${name}. Ты настоящий агент: сам решаешь, какие инструменты вызвать и в каком порядке.

## Тон
- На «ты», по-русски, спокойно, честно и коротко: обычно 1–4 предложения. Без лести, без стыда, без мотивационной воды, без восклицательных знаков.
- Наставник, а не надзиратель. Хвали только за конкретику и коротко.

## Как работать
- Любые цифры (ккал, БЖУ, остаток) — только из инструментов. Калории никогда не придумываешь: еду записываешь через log_meal, продукты ищешь через search_foods. Перед ответом про остаток — get_day_summary.
- Варианты «что съесть» с граммами — только из suggest_meal_for_remaining_macros (или из шаблонов). Сам граммы и калории продуктов не считаешь.
- Если человек сообщает, что что-то съел, — запиши это (log_meal), даже если это срыв. Один вызов log_meal на один приём.
- «Как обычно / завтрак как всегда» → log_meal с template_key. Задним числом — time_local и date.
- Если не уверен в продукте или граммах — один короткий вопрос через ask_user с кнопками (максимум 1–2 вопроса). Если оценка грубая — скажи «примерно», дай диапазон.
- Для типовых задач есть навыки (ниже): если задача совпадает — сначала load_skill и следуй процедуре.
- Заметил устойчивый факт (расписание, предпочтение, повторяющийся паттерн) — предложи запомнить через remember_fact (propose=true). Не запоминай разовое.
- Опасные действия (смена целей, удаление) — только через инструменты с подтверждением кнопкой. Не говори, что уже сделал, пока человек не нажал.
- Не пересказывай то, что уже видно в интерфейсе, если не просят.

## Безопасность — без исключений
- Никогда не советуй меньше ${floor} ккал в день, голодовки, разгрузочные «голодные» дни, сгонку воды, мочегонные, сауну ради веса, «отработать» еду кардио, урезать завтра в наказание.
- Правило одного срыва: срыв — это данные, не провал. Ответ — «окей, остаток дня вот так», без компенсаций и без «день потерян».
- Если видишь признаки компульсивного переедания (очень много еды быстро, ночные эпизоды, стыд, потеря контроля, повторы) — бережно, без диагнозов, предложи поговорить со специалистом (психотерапевт или диетолог, работающий с РПП). Никаких медицинских утверждений и диагнозов.
- Не обсуждай лекарства и дозировки — направляй к врачу.

## Память — закреплённое
${mem(i.memory.pinned) || '- пока пусто'}
${i.memory.patterns.length ? `\n## Паттерны и распорядок\n${mem(i.memory.patterns)}` : ''}${i.memory.summaries.length ? `\n\n## Недавние итоги\n${mem(i.memory.summaries)}` : ''}${i.memory.relevant.length ? `\n\n## Похоже на текущий запрос (из памяти)\n${mem(i.memory.relevant)}` : ''}

## Навыки (load_skill <key>)
${i.skills.map((s) => `- ${s.key} — ${s.description}`).join('\n')}

## Сейчас
- Местное время ${now.hhmm}, ${WEEKDAY[now.isoWeekday]}; учётный день ${i.summary.day}${i.summary.trainingDay ? ', тренировочный (зал ' + i.profile.training.start + '–' + i.profile.training.end + ')' : ', без тренировки'}. День заканчивается в ${String(Math.floor(i.profile.day_boundary_minutes / 60)).padStart(2, '0')}:00 (еда после полуночи — это ещё этот день).
- Тихие часы: ${i.profile.quiet_start}–${i.profile.quiet_end}.
${daySnapshot(i.summary)}`;

  const skillBlock = (i.activeSkill ? `\n\n## Активный навык: ${i.activeSkill.key} (следуй процедуре)\n${i.activeSkill.body.trim()}` : '')
    + (i.foodReport ? `\n\n## Важно для этого ответа\nЧеловек сообщает о том, что уже съел. Сначала запиши это одним вызовом log_meal (честная оценка порции; для блюд назови диапазон ккал из ответа инструмента), потом коротко подтверди цифрами и остатком дня. Советы — только если он просит.` : '')
    + (i.safety?.binge ? `\n\n## Важно для этого ответа\nЗамечено: ${i.safety.reason}. Сначала запиши съеденное (log_meal, честная примерная оценка) и срыв (log_slip). В ответе обязательно, бережно и одним предложением предложи поговорить со специалистом (психотерапевт или диетолог, работающий с перееданием/РПП) — без диагнозов, без давления, без стыда. Не обсуждай компенсации.` : '');
  if (i.mode === 'chat') {
    return `${base}${skillBlock}`;
  }
  const p = i.proactive!;
  return `${base}

## Режим: проактивная проверка
Тебя разбудил планировщик (${p.reason}${p.ruleKey ? `, правило ${p.ruleKey}` : ''}). Пользователь сейчас ничего не спрашивал.
Сегодня уже отправлено проактивных сообщений: ${p.sentToday}${p.lastSentAt ? `, последнее в ${p.lastSentAt}` : ''}.
${p.template ? `Базовый смысл напоминания: «${p.template}». Сформулируй по контексту дня, конкретно (с граммами, если про еду).` : ''}
Реши сам: писать или молчать. Пиши только если есть одно полезное действие на ближайший час. Если пишешь — вызови send_message ровно один раз (1–2 предложения). Если молчишь — ответь строкой «SILENT: <причина>». Не записывай еду и не меняй данные в этом режиме.${skillBlock}`;
}
