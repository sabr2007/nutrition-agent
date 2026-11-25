export type FoodState = 'raw' | 'cooked' | 'dry' | 'as_is';

export type Food = {
  id: string;
  user_id: string | null;
  source: string;
  name_ru: string;
  name_en?: string | null;
  brand?: string | null;
  barcode?: string | null;
  category?: string | null;
  state: FoodState;
  kcal_100g: number;
  /** null when only calories are known (a food the person named by kcal, D24). */
  protein_100g: number | null;
  fat_100g: number | null;
  carbs_100g: number | null;
  kcal_low_100g?: number | null;
  kcal_high_100g?: number | null;
  raw_food_id?: string | null;
  yield_factor?: number | null;
  default_portion_g?: number | null;
  portions?: { label: string; g: number }[];
  aliases?: string[] | null;
  confidence: 'high' | 'medium' | 'low' | 'user_kcal_only';
  score?: number;
};

/** `partial`: protein/fat/carbs are unknown (counted as 0 and flagged in day totals). */
export type Per100 = { kcal: number; protein: number; fat: number; carbs: number; partial?: boolean };

export type Macros = { kcal: number; protein_g: number; fat_g: number; carbs_g: number };

export type ItemSource = 'model' | 'user' | 'template' | 'scale' | 'barcode' | 'agent' | 'repeat';

/** A meal line ready to be saved (macros already computed deterministically). */
export type MealItemInput = Macros & {
  food_id: string | null;
  name: string;
  grams: number;
  state?: FoodState | null;
  per100: Per100 | null;
  confidence?: number | null;
  source: ItemSource;
  model_grams?: number | null;
  model_label?: string | null;
  edited?: boolean;
  kcal_range?: [number, number] | null;
};

export type Goal = {
  id: string;
  name: string;
  kind: 'challenge' | 'phase';
  starts_on: string;
  ends_on: string | null;
  kcal_min: number;
  kcal_max: number;
  kcal_floor: number;
  protein_min_g: number;
  protein_max_g: number | null;
  fat_min_g: number;
  fat_max_g: number | null;
  carbs_min_g: number | null;
  carbs_max_g: number | null;
  steps_min: number | null;
  steps_max: number | null;
  sleep_min_h: number | null;
  success_criteria: string | null;
  notes: string | null;
};

export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'shake' | 'supplement' | 'late';

export const SLOT_LABELS: Record<string, string> = {
  breakfast: 'Завтрак',
  lunch: 'Обед',
  dinner: 'Ужин',
  snack: 'Перекус',
  shake: 'Протеин',
  supplement: 'Добавка',
  late: 'Поздний приём',
};
