import type { SupabaseClient } from '@supabase/supabase-js';
import { getDaySummary, type DaySummary } from '@/lib/data/day';
import type { Profile } from '@/lib/data/profile';
import { getActivity } from '@/lib/health/activity';
import { hhmmToMin, localParts } from '@/lib/nutrition/day';
import { inQuietHours, minutesSince } from './dsl';
import type { Facts } from './dsl';

/** Walking pace for «N минут ходьбы». */
export const STEPS_PER_MIN = 100;
const TRACKED = 'google_health';

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
  const activity = (await getActivity(sb, userId, summary.day, summary.day).catch(() => []))[0];
  const ago = (iso: string | null | undefined) => (iso && Date.parse(iso) <= now.getTime() ? Math.round((now.getTime() - Date.parse(iso)) / 60_000) : null);
  const minutesSinceWake = ago(activity?.sleep?.end);
  const minutesSinceQuietEnd = inQuietHours(local.hhmm, profile.quiet_start.slice(0, 5), profile.quiet_end.slice(0, 5)) ? null : minutesSince(local.hhmm, profile.quiet_end.slice(0, 5));
  const tracked = (activity?.workouts ?? []).filter((x) => x.source === TRACKED && ago(x.end) != null).sort((a, b) => Date.parse(b.end!) - Date.parse(a.end!))[0];
  const steps = activity?.steps ?? null;
  const stepsGoal = g?.steps_min ?? null;
  const stepsLeft = steps != null && stepsGoal ? Math.max(0, stepsGoal - steps) : null;
  const sinceLastMeal = lastMeal ? Math.round((now.getTime() - Date.parse(lastMeal.eaten_at)) / 60_000) : null;
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
    minutes_of_day: hhmmToMin(local.hhmm),
    protein_pct: g?.protein_min_g ? Math.round((summary.totals.protein_g / g.protein_min_g) * 100) : null,
    steps,
    steps_goal: stepsGoal,
    steps_pct: steps != null && stepsGoal ? Math.round((steps / stepsGoal) * 100) : null,
    steps_left: stepsLeft,
    walk_minutes: stepsLeft != null ? Math.ceil(stepsLeft / STEPS_PER_MIN) : null,
    sleep_minutes: activity?.sleep?.minutes ?? null,
    minutes_since_wake: minutesSinceWake,
    minutes_since_quiet_end: minutesSinceQuietEnd,
    minutes_since_tracked_workout_end: tracked ? ago(tracked.end) : null,
    workout_kcal: tracked?.kcal ?? null,
    // Food: since the last meal; with none today — since waking up (or the end of the quiet hours).
    minutes_since_food: sinceLastMeal ?? minutesSinceWake ?? minutesSinceQuietEnd,
    challenge_day: summary.challengeDay?.n ?? null,
    checked,
    logged_slot: loggedSlot,
    training_hint: summary.trainingDay ? ' И банан перед залом.' : '',
    name: profile.display_name ?? '',
  };
  return { facts, summary };
}
