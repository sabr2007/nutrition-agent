import type { Food, FoodState, Macros, MealItemInput, Per100, ItemSource } from './types';

/** Round to one decimal (how we store macros). */
export const r1 = (n: number): number => Math.round(n * 10) / 10;

export function per100Of(food: Pick<Food, 'kcal_100g' | 'protein_100g' | 'fat_100g' | 'carbs_100g'>): Per100 {
  const partial = food.protein_100g == null || food.fat_100g == null || food.carbs_100g == null;
  return {
    kcal: Number(food.kcal_100g),
    protein: Number(food.protein_100g ?? 0),
    fat: Number(food.fat_100g ?? 0),
    carbs: Number(food.carbs_100g ?? 0),
    ...(partial ? { partial: true } : {}),
  };
}

/** Deterministic macro calculation: grams x per-100 g values. The LLM never does this. */
export function macrosFor(grams: number, per100: Per100): Macros {
  if (!Number.isFinite(grams) || grams < 0) throw new Error(`invalid grams: ${grams}`);
  const k = grams / 100;
  return {
    kcal: r1(per100.kcal * k),
    protein_g: r1(per100.protein * k),
    fat_g: r1(per100.fat * k),
    carbs_g: r1(per100.carbs * k),
  };
}

export function sumMacros(items: Macros[]): Macros {
  const s = items.reduce(
    (acc, it) => ({
      kcal: acc.kcal + it.kcal,
      protein_g: acc.protein_g + it.protein_g,
      fat_g: acc.fat_g + it.fat_g,
      carbs_g: acc.carbs_g + it.carbs_g,
    }),
    { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );
  return { kcal: r1(s.kcal), protein_g: r1(s.protein_g), fat_g: r1(s.fat_g), carbs_g: r1(s.carbs_g) };
}

/**
 * Converts a weight measured in one state to the weight in the food row's state using
 * the cooked/raw yield factor (cooked weight / raw weight). Example: 150 g cooked chicken
 * with yield 0.75 => 200 g raw.
 */
export function convertWeight(grams: number, from: FoodState, to: FoodState, yieldFactor: number | null | undefined): number {
  if (from === to || from === 'as_is' || to === 'as_is') return grams;
  if (!yieldFactor || yieldFactor <= 0) return grams;
  const fromCooked = from === 'cooked';
  const toCooked = to === 'cooked';
  if (fromCooked && !toCooked) return r1(grams / yieldFactor);
  if (!fromCooked && toCooked) return r1(grams * yieldFactor);
  return grams;
}

/** kcal range for composite dishes with honest uncertainty. */
export function kcalRange(grams: number, food: Pick<Food, 'kcal_low_100g' | 'kcal_high_100g'>): [number, number] | null {
  if (food.kcal_low_100g == null || food.kcal_high_100g == null) return null;
  return [Math.round((Number(food.kcal_low_100g) * grams) / 100), Math.round((Number(food.kcal_high_100g) * grams) / 100)];
}

export function itemFromFood(
  food: Food,
  grams: number,
  opts: { source: ItemSource; confidence?: number | null; model_grams?: number | null; model_label?: string | null; name?: string; edited?: boolean } ,
): MealItemInput {
  const per100 = per100Of(food);
  return {
    food_id: food.id,
    name: opts.name ?? food.name_ru,
    grams: r1(grams),
    state: food.state,
    per100,
    ...macrosFor(grams, per100),
    confidence: opts.confidence ?? null,
    source: opts.source,
    model_grams: opts.model_grams ?? null,
    model_label: opts.model_label ?? null,
    edited: opts.edited ?? false,
    kcal_range: kcalRange(grams, food),
  };
}

/** Recompute an item after the user changes grams (keeps per-100 snapshot). */
export function withGrams(item: MealItemInput, grams: number): MealItemInput {
  if (!item.per100) return { ...item, grams: r1(grams), edited: true };
  const factor = item.grams > 0 ? grams / item.grams : 0;
  return {
    ...item,
    grams: r1(grams),
    ...macrosFor(grams, item.per100),
    edited: true,
    kcal_range: item.kcal_range ? [Math.round(item.kcal_range[0] * factor), Math.round(item.kcal_range[1] * factor)] : null,
  };
}

/** Portion helpers for common counted foods. */
export function gramsForPortion(food: Pick<Food, 'portions' | 'default_portion_g'>, count = 1, label?: string): number | null {
  const portions = food.portions ?? [];
  const p = label ? portions.find((x) => x.label === label) : portions[0];
  if (p) return r1(p.g * count);
  return food.default_portion_g ? r1(Number(food.default_portion_g) * count) : null;
}
