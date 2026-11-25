import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_BOUNDARY_MIN, DEFAULT_TZ, isoWeekdayOf, localDay } from '@/lib/nutrition/day';
import type { Goal } from '@/lib/nutrition/types';

export type Training = { days: number[]; start: string; end: string };

export type Profile = {
  user_id: string;
  display_name: string | null;
  timezone: string;
  day_boundary_minutes: number;
  quiet_start: string;
  quiet_end: string;
  max_proactive_per_day: number;
  min_minutes_between_proactive: number;
  training: Training;
  dislikes: string[];
  budget_notes: string | null;
  height_cm: number | null;
  settings: Record<string, unknown>;
};

export async function getProfile(sb: SupabaseClient, userId: string): Promise<Profile> {
  return (await findProfile(sb, userId)) ?? profileFrom(userId, {});
}

/** The profile row, or null when the account has none (a broken sign-up). */
export async function findProfile(sb: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await sb.from('profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`profile: ${error.message}`);
  return data ? profileFrom(userId, data as Partial<Profile>) : null;
}

function profileFrom(userId: string, p: Partial<Profile>): Profile {
  return {
    user_id: userId,
    display_name: p.display_name ?? null,
    timezone: p.timezone ?? DEFAULT_TZ,
    day_boundary_minutes: p.day_boundary_minutes ?? DEFAULT_BOUNDARY_MIN,
    quiet_start: (p.quiet_start ?? '23:00').slice(0, 5),
    quiet_end: (p.quiet_end ?? '08:00').slice(0, 5),
    max_proactive_per_day: p.max_proactive_per_day ?? 6,
    min_minutes_between_proactive: p.min_minutes_between_proactive ?? 90,
    training: (p.training as Training) ?? { days: [1, 3, 5], start: '18:00', end: '19:30' },
    dislikes: p.dislikes ?? [],
    budget_notes: p.budget_notes ?? null,
    height_cm: p.height_cm ?? null,
    settings: (p.settings as Record<string, unknown>) ?? {},
  };
}

export function todayFor(profile: Pick<Profile, 'timezone' | 'day_boundary_minutes'>, now = new Date()): string {
  return localDay(now, profile.timezone, profile.day_boundary_minutes);
}

export function isTrainingDay(profile: Pick<Profile, 'training'>, day: string): boolean {
  return profile.training.days.includes(isoWeekdayOf(day));
}

export async function goalForDay(sb: SupabaseClient, userId: string, day: string): Promise<Goal | null> {
  const { data, error } = await sb.from('goals').select('*').eq('user_id', userId).eq('is_current', true)
    .lte('starts_on', day).or(`ends_on.is.null,ends_on.gte.${day}`)
    .order('starts_on', { ascending: false }).order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`goals: ${error.message}`);
  return (data?.[0] as Goal) ?? null;
}
