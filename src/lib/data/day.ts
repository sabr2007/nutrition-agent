import type { SupabaseClient } from '@supabase/supabase-js';
import type { Goal } from '@/lib/nutrition/types';
import { r1 } from '@/lib/nutrition/calc';
import { getProfile, goalForDay, isTrainingDay, todayFor, type Profile } from './profile';

export type DayMeal = {
  id: string; root_id: string; eaten_at: string; logged_at: string; slot: string | null; title: string | null;
  input_method: string; template_id: string | null; confidence: number | null; kcal: number; protein_g: number;
  fat_g: number; carbs_g: number; note: string | null; is_labeled: boolean;
  items: { id: string; food_id: string | null; name: string; grams: number; kcal: number; protein_g: number; fat_g: number; carbs_g: number; confidence: number | null; source: string }[];
};

export type ChecklistRow = {
  key: string; label: string; kind: 'bool' | 'number'; unit: string | null; target: number | null;
  due_time: string | null; training_day_only: boolean; done: boolean; value: number | null; source: string | null;
};

export type DaySummary = {
  day: string;
  isToday: boolean;
  trainingDay: boolean;
  goal: Goal | null;
  totals: { kcal: number; protein_g: number; fat_g: number; carbs_g: number; meals_count: number };
  remaining: { kcal_to_min: number; kcal_to_max: number; protein_to_min: number; fat_to_min: number } | null;
  status: { kcal: 'under' | 'in' | 'over'; protein: 'under' | 'in' | 'over'; belowFloor: boolean } | null;
  meals: DayMeal[];
  checklist: ChecklistRow[];
  challengeDay: { n: number; of: number } | null;
  profile: Pick<Profile, 'timezone' | 'day_boundary_minutes' | 'training' | 'display_name'>;
};

const band = (v: number, lo: number, hi: number | null): 'under' | 'in' | 'over' => (v < lo ? 'under' : hi != null && v > hi ? 'over' : 'in');

export async function getDaySummary(sb: SupabaseClient, userId: string, day?: string, profileIn?: Profile): Promise<DaySummary> {
  const profile = profileIn ?? (await getProfile(sb, userId));
  const today = todayFor(profile);
  const d = day ?? today;
  const [goal, mealsRes, itemsRes, marksRes] = await Promise.all([
    goalForDay(sb, userId, d),
    sb.from('meals').select('id, root_id, eaten_at, logged_at, slot, title, input_method, template_id, confidence, kcal, protein_g, fat_g, carbs_g, note, is_labeled, meal_items(id, food_id, name, grams, kcal, protein_g, fat_g, carbs_g, confidence, source, sort_order)')
      .eq('user_id', userId).eq('local_day', d).eq('is_current', true).eq('status', 'confirmed').order('eaten_at'),
    sb.from('checklist_items').select('key, label, kind, unit, target, due_time, training_day_only, sort_order').eq('user_id', userId).eq('active', true).order('sort_order'),
    sb.from('checklist_state').select('item_key, done, value, source').eq('user_id', userId).eq('local_day', d),
  ]);
  if (mealsRes.error) throw new Error(`meals: ${mealsRes.error.message}`);
  const meals: DayMeal[] = (mealsRes.data ?? []).map((m) => ({
    ...(m as unknown as DayMeal),
    kcal: Number(m.kcal), protein_g: Number(m.protein_g), fat_g: Number(m.fat_g), carbs_g: Number(m.carbs_g),
    items: ((m.meal_items ?? []) as unknown as (DayMeal['items'][number] & { sort_order: number })[])
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(({ sort_order: _s, ...i }) => ({ ...i, grams: Number(i.grams), kcal: Number(i.kcal), protein_g: Number(i.protein_g), fat_g: Number(i.fat_g), carbs_g: Number(i.carbs_g) })),
  }));
  const totals = meals.reduce((a, m) => ({
    kcal: a.kcal + m.kcal, protein_g: a.protein_g + m.protein_g, fat_g: a.fat_g + m.fat_g, carbs_g: a.carbs_g + m.carbs_g,
    meals_count: a.meals_count + (m.slot === 'supplement' ? 0 : 1),
  }), { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, meals_count: 0 });
  const t = { kcal: Math.round(totals.kcal), protein_g: r1(totals.protein_g), fat_g: r1(totals.fat_g), carbs_g: r1(totals.carbs_g), meals_count: totals.meals_count };
  const trainingDay = isTrainingDay(profile, d);
  const marks = new Map((marksRes.data ?? []).map((m) => [m.item_key as string, m]));
  const checklist: ChecklistRow[] = (itemsRes.data ?? [])
    .filter((i) => !i.training_day_only || trainingDay)
    .map((i) => {
      const m = marks.get(i.key as string);
      return {
        key: i.key as string, label: i.label as string, kind: i.kind as 'bool' | 'number', unit: (i.unit as string) ?? null,
        target: i.target != null ? Number(i.target) : null, due_time: (i.due_time as string)?.slice(0, 5) ?? null,
        training_day_only: Boolean(i.training_day_only), done: Boolean(m?.done), value: m?.value != null ? Number(m.value) : null,
        source: (m?.source as string) ?? null,
      };
    });
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
    remaining: goal ? {
      kcal_to_min: Math.round(goal.kcal_min - t.kcal),
      kcal_to_max: Math.round(goal.kcal_max - t.kcal),
      protein_to_min: Math.round(goal.protein_min_g - t.protein_g),
      fat_to_min: Math.round(goal.fat_min_g - t.fat_g),
    } : null,
    status: goal ? {
      kcal: band(t.kcal, goal.kcal_min, goal.kcal_max),
      protein: band(t.protein_g, goal.protein_min_g, goal.protein_max_g),
      belowFloor: t.kcal < goal.kcal_floor,
    } : null,
    meals,
    checklist,
    challengeDay,
    profile: { timezone: profile.timezone, day_boundary_minutes: profile.day_boundary_minutes, training: profile.training, display_name: profile.display_name },
  };
}
