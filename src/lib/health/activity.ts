import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, localParts } from '@/lib/nutrition/day';

// Activity for the agent and the reminders (D28): one view over health_daily / health_sleep /
// workouts whatever the source — Google Health first, the Shortcuts import as a fallback.

export type DayActivity = {
  day: string;
  steps: number | null;
  active_kcal: number | null;
  total_kcal: number | null;
  resting_hr: number | null;
  sleep: { minutes: number | null; start: string | null; end: string | null; stages: Record<string, number> } | null;
  workouts: { kind: string; start: string | null; end: string | null; duration_min: number | null; kcal: number | null; source: string }[];
  source: string | null;
  synced_at: string | null;
};

const SOURCE_ORDER = ['google_health', 'shortcuts', 'manual'];
const rank = (s: string) => { const i = SOURCE_ORDER.indexOf(s); return i < 0 ? 99 : i; };

export async function getActivity(sb: SupabaseClient, userId: string, from: string, to: string): Promise<DayActivity[]> {
  const [daily, sleep, workouts] = await Promise.all([
    sb.from('health_daily').select('local_day, source, steps, active_kcal, total_kcal, resting_hr, synced_at').eq('user_id', userId).gte('local_day', from).lte('local_day', to),
    sb.from('health_sleep').select('night_of, source, start_at, end_at, minutes, stages').eq('user_id', userId).gte('night_of', from).lte('night_of', to),
    sb.from('workouts').select('local_day, kind, started_at, ended_at, duration_min, kcal, source').eq('user_id', userId).gte('local_day', from).lte('local_day', to).order('started_at'),
  ]);
  const days: DayActivity[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const best = (daily.data ?? []).filter((r) => r.local_day === d).sort((a, b) => rank(a.source as string) - rank(b.source as string))[0];
    const night = (sleep.data ?? []).filter((r) => r.night_of === d).sort((a, b) => rank(a.source as string) - rank(b.source as string))[0];
    const num = (v: unknown) => (v == null ? null : Number(v));
    days.push({
      day: d,
      steps: num(best?.steps), active_kcal: num(best?.active_kcal), total_kcal: num(best?.total_kcal), resting_hr: num(best?.resting_hr),
      sleep: night ? { minutes: num(night.minutes), start: (night.start_at as string) ?? null, end: (night.end_at as string) ?? null, stages: (night.stages as Record<string, number>) ?? {} } : null,
      workouts: (workouts.data ?? []).filter((w) => w.local_day === d).map((w) => ({ kind: w.kind as string, start: (w.started_at as string) ?? null, end: (w.ended_at as string) ?? null, duration_min: num(w.duration_min), kcal: num(w.kcal), source: w.source as string })),
      source: (best?.source as string) ?? (night?.source as string) ?? null,
      synced_at: (best?.synced_at as string) ?? null,
    });
  }
  return days;
}

const hm = (minutes: number) => `${Math.floor(minutes / 60)} ч ${String(Math.round(minutes % 60)).padStart(2, '0')} мин`;

/** Lines for the agent's day snapshot: steps so far, last night's sleep, today's workout. */
export function activityLines(today: DayActivity | undefined, tz: string, stepsGoal: number | null): string[] {
  if (!today) return [];
  const out: string[] = [];
  if (today.steps != null) out.push(`- Шаги к ${localParts(new Date(), tz).hhmm}: ${today.steps.toLocaleString('ru-RU')}${stepsGoal ? ` (цель ${stepsGoal.toLocaleString('ru-RU')})` : ''}${today.active_kcal != null ? `, активные ${Math.round(today.active_kcal)} ккал` : ''}.`);
  if (today.sleep?.minutes != null) {
    const s = today.sleep;
    const span = s.start && s.end ? ` (отбой ${localParts(new Date(s.start), tz).hhmm}, подъём ${localParts(new Date(s.end), tz).hhmm})` : '';
    const deep = s.stages.deep != null ? `, глубокий ${s.stages.deep} мин` : '';
    out.push(`- Сон прошлой ночи: ${hm(s.minutes!)}${span}${deep}.${s.minutes! < 360 ? ' Мало сна — без агрессивного дефицита, держись верхней границы калорий.' : ''}`);
  }
  for (const w of today.workouts) {
    out.push(`- Тренировка сегодня: ${w.kind}${w.start ? ` ${localParts(new Date(w.start), tz).hhmm}` : ''}${w.duration_min != null ? `, ${w.duration_min} мин` : ''}${w.kcal != null ? `, ${Math.round(w.kcal)} ккал` : ''}. После неё — белок и углеводы.`);
  }
  if (today.resting_hr != null) out.push(`- Пульс покоя: ${Math.round(today.resting_hr)}.`);
  return out;
}
