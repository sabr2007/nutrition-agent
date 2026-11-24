import type { SupabaseClient } from '@supabase/supabase-js';
import type { Goal } from '@/lib/nutrition/types';
import { addDays } from '@/lib/nutrition/day';
import { todayFor, type Profile } from '@/lib/data/profile';

export async function getTrends(sb: SupabaseClient, userId: string, profile: Profile, days: number) {
  const to = todayFor(profile);
  const from = addDays(to, -(days - 1));
  const [totals, goals, weights, waist, slips] = await Promise.all([
    sb.from('day_totals').select('local_day, meals_count, kcal, protein_g, fat_g, carbs_g').eq('user_id', userId).gte('local_day', from).lte('local_day', to).order('local_day'),
    sb.from('goals').select('*').eq('user_id', userId).eq('is_current', true),
    sb.from('weight_daily').select('local_day, weight, avg7, n7').eq('user_id', userId).gte('local_day', addDays(from, -7)).lte('local_day', to).order('local_day'),
    sb.from('body_metrics').select('local_day, value').eq('user_id', userId).eq('kind', 'waist').eq('is_current', true).order('measured_at'),
    sb.from('slips').select('local_day, trigger, location, feeling').eq('user_id', userId).gte('local_day', from).lte('local_day', to),
  ]);
  const goalFor = (d: string) => ((goals.data ?? []) as Goal[])
    .filter((g) => g.starts_on <= d && (!g.ends_on || g.ends_on >= d))
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0];
  const perDay = (totals.data ?? []).map((t) => {
    const g = goalFor(t.local_day as string);
    const kcal = Math.round(Number(t.kcal));
    const protein = Number(t.protein_g);
    const inPlan = g ? kcal >= g.kcal_min && kcal <= g.kcal_max && protein >= g.protein_min_g : null;
    const target = g ? { kcal_min: g.kcal_min, kcal_max: g.kcal_max, protein_min_g: g.protein_min_g, protein_max_g: g.protein_max_g ?? null } : null;
    return { day: t.local_day, meals: t.meals_count, kcal, protein_g: protein, fat_g: Number(t.fat_g), carbs_g: Number(t.carbs_g), in_plan: inPlan, protein_hit: g ? protein >= g.protein_min_g : null, target };
  });
  const loggedDays = perDay.filter((d) => Number(d.meals) >= 3).length;
  const w = (weights.data ?? []).filter((x) => (x.local_day as string) >= from);
  const firstAvg = w.find((x) => x.avg7 != null)?.avg7;
  const lastAvg = [...w].reverse().find((x) => x.avg7 != null)?.avg7;
  const triggers: Record<string, number> = {};
  for (const s of slips.data ?? []) triggers[(s.trigger as string) ?? 'не указан'] = (triggers[(s.trigger as string) ?? 'не указан'] ?? 0) + 1;
  return {
    range: [from, to], days,
    days_with_data: perDay.length,
    days_in_plan: perDay.filter((d) => d.in_plan).length,
    protein_hit_days: perDay.filter((d) => d.protein_hit).length,
    days_logged_3plus_meals: loggedDays,
    avg_kcal: perDay.length ? Math.round(perDay.reduce((a, d) => a + d.kcal, 0) / perDay.length) : null,
    avg_protein_g: perDay.length ? Math.round(perDay.reduce((a, d) => a + d.protein_g, 0) / perDay.length) : null,
    per_day: perDay,
    weight: { points: w.map((x) => ({ day: x.local_day, kg: Number(x.weight), avg7: x.avg7 != null ? Number(x.avg7) : null })), avg7_change_kg: firstAvg != null && lastAvg != null ? Number((Number(lastAvg) - Number(firstAvg)).toFixed(2)) : null },
    waist_cm: (waist.data ?? []).map((x) => ({ day: x.local_day, cm: Number(x.value) })),
    slips: { count: (slips.data ?? []).length, by_trigger: triggers },
  };
}
