import type { SupabaseClient } from '@supabase/supabase-js';
import { getDaySummary, type DaySummary } from '@/lib/data/day';
import type { Profile } from '@/lib/data/profile';
import { localParts } from '@/lib/nutrition/day';
import { minutesSince } from './dsl';
import type { Facts } from './dsl';

export async function computeFacts(sb: SupabaseClient, userId: string, profile: Profile, now = new Date()): Promise<{ facts: Facts; summary: DaySummary }> {
  const summary = await getDaySummary(sb, userId, undefined, profile);
  const local = localParts(now, profile.timezone);
  const checked: Record<string, boolean> = {};
  for (const c of summary.checklist) checked[c.key] = c.done;
  const loggedSlot: Record<string, boolean> = {};
  for (const m of summary.meals) if (m.slot) loggedSlot[m.slot] = true;
  const lastMeal = summary.meals[summary.meals.length - 1];

  // Workout end: a logged workout wins; otherwise the training schedule.
  let minutesSinceWorkoutEnd: number | null = null;
  const { data: w } = await sb.from('workouts').select('ended_at').eq('user_id', userId).eq('local_day', summary.day).not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(1);
  if (w?.[0]?.ended_at) {
    minutesSinceWorkoutEnd = Math.round((now.getTime() - Date.parse(w[0].ended_at as string)) / 60_000);
  } else if (summary.trainingDay) {
    const since = minutesSince(local.hhmm, profile.training.end);
    minutesSinceWorkoutEnd = since < 12 * 60 ? since : null;
  }
  const g = summary.goal;
  const facts: Facts = {
    local_time: local.hhmm,
    weekday: local.isoWeekday,
    day: summary.day,
    is_training_day: summary.trainingDay,
    meals_count: summary.totals.meals_count,
    kcal: summary.totals.kcal,
    protein_g: summary.totals.protein_g,
    fat_g: summary.totals.fat_g,
    carbs_g: summary.totals.carbs_g,
    protein_remaining: g ? Math.max(0, Math.round(g.protein_min_g - summary.totals.protein_g)) : null,
    kcal_remaining: g ? Math.round(g.kcal_max - summary.totals.kcal) : null,
    kcal_to_min: g ? Math.round(g.kcal_min - summary.totals.kcal) : null,
    minutes_since_last_meal: lastMeal ? Math.round((now.getTime() - Date.parse(lastMeal.eaten_at)) / 60_000) : null,
    minutes_since_workout_end: minutesSinceWorkoutEnd,
    challenge_day: summary.challengeDay?.n ?? null,
    checked,
    logged_slot: loggedSlot,
    training_hint: summary.trainingDay ? ' И банан перед залом.' : '',
    name: profile.display_name ?? '',
  };
  return { facts, summary };
}
