// A dry run's private copy of the world (agent evals): foods the agent saves and meals it
// logs, edits or deletes live here, so multi-step scenarios («исправь, там 250 ккал») can be
// checked against what *would* be in the database, without writing anything.
import type { DayMeal, DaySummary } from '@/lib/data/day';
import { progressOf, totalsOf } from '@/lib/data/day';
import type { Food } from '@/lib/nutrition/types';
import type { DayActivity } from '@/lib/health/activity';

export type DryMealItem = {
  food_id: string | null; name: string; grams: number;
  kcal: number; protein_g: number; fat_g: number; carbs_g: number; partial?: boolean;
};

export type DryMeal = {
  id: string; root_id: string; title: string; slot: string | null; eaten_at: string;
  /** When the first version was logged and whether the agent logged it (undo without a button). */
  created_at: string; by_agent: boolean;
  status: 'confirmed' | 'deleted'; is_current: boolean;
  items: DryMealItem[];
};

export type DryEffect =
  | { kind: 'food'; food_id: string; name: string; kcal_100g: number }
  | { kind: 'log'; meal_id: string; title: string; kcal: number; grams: number }
  | { kind: 'edit'; meal_id: string; root_id: string; title: string; kcal: number }
  | { kind: 'delete'; meal_id: string; root_id: string; immediate: boolean };

/** `replaceDay`: the simulated meals are the whole day (deterministic evals), not added to the real one. */
export type DryWorld = { foods: Map<string, Food>; meals: Map<string, DryMeal>; effects: DryEffect[]; nudges: { kind: string; meal_id: string }[]; replaceDay?: boolean; activity?: DayActivity };

export function newDryWorld(fixture?: { meals?: DryMeal[]; foods?: Food[]; replaceDay?: boolean; activity?: DayActivity }): DryWorld {
  return {
    activity: fixture?.activity,
    replaceDay: fixture?.replaceDay ?? false,
    foods: new Map((fixture?.foods ?? []).map((f) => [f.id, f])),
    meals: new Map((fixture?.meals ?? []).map((m) => [m.id, m])),
    effects: [],
    nudges: [],
  };
}

export const mealTotals = (items: DryMealItem[]) => items.reduce(
  (a, i) => ({ kcal: a.kcal + i.kcal, protein_g: a.protein_g + i.protein_g, fat_g: a.fat_g + i.fat_g, carbs_g: a.carbs_g + i.carbs_g }),
  { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
);

/** The current version of a simulated meal by any of its version ids. */
export function currentDryMeal(w: DryWorld, id: string): DryMeal | null {
  const m = w.meals.get(id);
  if (!m) return null;
  if (m.is_current) return m;
  return [...w.meals.values()].find((x) => x.root_id === m.root_id && x.is_current) ?? null;
}

function asDayMeal(m: DryMeal): DayMeal {
  const t = mealTotals(m.items);
  return {
    id: m.id, root_id: m.root_id, eaten_at: m.eaten_at, logged_at: m.created_at, slot: m.slot, title: m.title,
    input_method: m.by_agent ? 'agent' : 'manual', template_id: null, confidence: null, note: null, is_labeled: false,
    kcal: t.kcal, protein_g: t.protein_g, fat_g: t.fat_g, carbs_g: t.carbs_g,
    items: m.items.map((i, n) => ({ id: `${m.id}:${n}`, food_id: i.food_id, name: i.name, grams: i.grams, kcal: i.kcal, protein_g: i.protein_g, fat_g: i.fat_g, carbs_g: i.carbs_g, confidence: null, source: 'agent', partial: Boolean(i.partial) })),
  };
}

/** The real day plus the simulated meals (only for today's summary). */
export function overlayDay(s: DaySummary, w: DryWorld | undefined): DaySummary {
  if (!w || !s.isToday) return s;
  const extra = [...w.meals.values()].filter((m) => m.is_current && m.status === 'confirmed').map(asDayMeal);
  if (!extra.length && !w.meals.size && !w.replaceDay) return s;
  const meals = [...(w.replaceDay ? [] : s.meals), ...extra].sort((a, b) => a.eaten_at.localeCompare(b.eaten_at));
  const totals = totalsOf(meals);
  return { ...s, meals, totals, ...progressOf(s.goal, totals) };
}
