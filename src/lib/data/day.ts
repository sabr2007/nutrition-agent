import type { SupabaseClient } from '@supabase/supabase-js';
import type { Goal } from '@/lib/nutrition/types';
import { r1 } from '@/lib/nutrition/calc';
import { getProfile, goalForDay, isTrainingDay, todayFor, type Profile } from './profile';

export type DayMeal = {
  id: string; root_id: string; eaten_at: string; logged_at: string; slot: string | null; title: string | null;
  input_method: string; template_id: string | null; confidence: number | null; kcal: number; protein_g: number;
  fat_g: number; carbs_g: number; note: string | null; is_labeled: boolean;
  /** Saturated fat of the meal; null when none of its foods know it. */
  satfat_g?: number | null;
  /** `partial`: only calories are known for this item (protein/fat/carbs counted as 0). */
  items: { id: string; food_id: string | null; name: string; grams: number; kcal: number; protein_g: number; fat_g: number; carbs_g: number; confidence: number | null; source: string; partial: boolean }[];
};

export type DaySummary = {
  day: string;
  isToday: boolean;
  trainingDay: boolean;
  goal: Goal | null;
  /** `macros_incomplete`: items whose protein/fat/carbs are unknown (counted as 0). */
  totals: { kcal: number; protein_g: number; fat_g: number; carbs_g: number; meals_count: number; macros_incomplete: number; satfat_g: number | null };
  remaining: { kcal_to_min: number; kcal_to_max: number; protein_to_min: number; fat_to_min: number } | null;
  status: { kcal: 'under' | 'in' | 'over'; protein: 'under' | 'in' | 'over'; belowFloor: boolean } | null;
  meals: DayMeal[];
  challengeDay: { n: number; of: number } | null;
  profile: Pick<Profile, 'timezone' | 'day_boundary_minutes' | 'training' | 'display_name'>;
};

const band = (v: number, lo: number, hi: number | null): 'under' | 'in' | 'over' => (v < lo ? 'under' : hi != null && v > hi ? 'over' : 'in');

/** Day totals from its meals (supplements are not counted as meals). */
export function totalsOf(meals: DayMeal[]): DaySummary['totals'] {
  const sum = meals.reduce((a, m) => ({
    kcal: a.kcal + m.kcal, protein_g: a.protein_g + m.protein_g, fat_g: a.fat_g + m.fat_g, carbs_g: a.carbs_g + m.carbs_g,
    meals_count: a.meals_count + (m.slot === 'supplement' ? 0 : 1),
    macros_incomplete: a.macros_incomplete + m.items.filter((i) => i.partial).length,
    satfat_g: m.satfat_g != null ? (a.satfat_g ?? 0) + Number(m.satfat_g) : a.satfat_g,
  }), { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, meals_count: 0, macros_incomplete: 0, satfat_g: null as number | null });
  return { ...sum, kcal: Math.round(sum.kcal), protein_g: r1(sum.protein_g), fat_g: r1(sum.fat_g), carbs_g: r1(sum.carbs_g), satfat_g: sum.satfat_g != null ? r1(sum.satfat_g) : null };
}

/** What is left to the goal and where the day stands. */
export function progressOf(goal: Goal | null, t: DaySummary['totals']): Pick<DaySummary, 'remaining' | 'status'> {
  if (!goal) return { remaining: null, status: null };
  return {
    remaining: {
      kcal_to_min: Math.round(goal.kcal_min - t.kcal),
      kcal_to_max: Math.round(goal.kcal_max - t.kcal),
      protein_to_min: Math.round(goal.protein_min_g - t.protein_g),
      fat_to_min: Math.round(goal.fat_min_g - t.fat_g),
    },
    status: {
      kcal: band(t.kcal, goal.kcal_min, goal.kcal_max),
      protein: band(t.protein_g, goal.protein_min_g, goal.protein_max_g),
      belowFloor: t.kcal < goal.kcal_floor,
    },
  };
}

export async function getDaySummary(sb: SupabaseClient, userId: string, day?: string, profileIn?: Profile): Promise<DaySummary> {
  const profile = profileIn ?? (await getProfile(sb, userId));
  const today = todayFor(profile);
  const d = day ?? today;
  const [goal, mealsRes] = await Promise.all([
    goalForDay(sb, userId, d),
    sb.from('meals').select('id, root_id, eaten_at, logged_at, slot, title, input_method, template_id, confidence, kcal, protein_g, fat_g, carbs_g, satfat_g, note, is_labeled, meal_items(id, food_id, name, grams, kcal, protein_g, fat_g, carbs_g, confidence, source, sort_order, per100)')
      .eq('user_id', userId).eq('local_day', d).eq('is_current', true).eq('status', 'confirmed').order('eaten_at'),
  ]);
  if (mealsRes.error) throw new Error(`meals: ${mealsRes.error.message}`);
  const meals: DayMeal[] = (mealsRes.data ?? []).map((m) => ({
    ...(m as unknown as DayMeal),
    kcal: Number(m.kcal), protein_g: Number(m.protein_g), fat_g: Number(m.fat_g), carbs_g: Number(m.carbs_g),
    satfat_g: m.satfat_g != null ? Number(m.satfat_g) : null,
    items: ((m.meal_items ?? []) as unknown as (Omit<DayMeal['items'][number], 'partial'> & { sort_order: number; per100: { partial?: boolean } | null })[])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(({ sort_order: _s, per100, ...i }) => ({
        ...i, grams: Number(i.grams), kcal: Number(i.kcal), protein_g: Number(i.protein_g), fat_g: Number(i.fat_g), carbs_g: Number(i.carbs_g),
        partial: Boolean(per100?.partial),
      })),
  }));
  const t = totalsOf(meals);
  const trainingDay = isTrainingDay(profile, d);
  let challengeDay: DaySummary['challengeDay'] = null;
  if (goal?.kind === 'challenge' && goal.ends_on) {
    const start = Date.parse(goal.starts_on);
    const n = Math.floor((Date.parse(d) - start) / 86_400_000) + 1;
    const of = Math.floor((Date.parse(goal.ends_on) - start) / 86_400_000) + 1;
    challengeDay = { n, of };
  }
  return {
    day: d,
    isToday: d === today,
    trainingDay,
    goal,
    totals: t,
    ...progressOf(goal, t),
    meals,
    challengeDay,
    profile: { timezone: profile.timezone, day_boundary_minutes: profile.day_boundary_minutes, training: profile.training, display_name: profile.display_name },
  };
}
