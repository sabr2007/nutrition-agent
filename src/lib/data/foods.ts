import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Food } from '@/lib/nutrition/types';
import { cleanFoodName, foodKey, sameNumbers, userFoodNumbers, type UserFoodInput, type UserFoodNumbers } from '@/lib/nutrition/user-food';

const MACRO_SUM_LIMIT = 100.5;
const KCAL_TOLERANCE = 0.6;
const MACRO_TOLERANCE = 0.15;

export const PersonalFoodSchema = z.object({
  name: z.string().trim().min(1).max(160),
  brand: z.string().trim().max(80).nullish(),
  state: z.enum(['as_is', 'raw', 'dry', 'cooked']).default('as_is'),
  kcal: z.number().min(0).max(900),
  protein: z.number().min(0).max(100),
  fat: z.number().min(0).max(100),
  carbs: z.number().min(0).max(100),
  fiber: z.number().min(0).max(100).nullish(),
  portion_g: z.number().positive().max(3000).nullish(),
  barcode: z.string().regex(/^\d{8,14}$/).nullish(),
  recognition_id: z.string().uuid().nullish(),
}).refine((b) => b.protein + b.fat + b.carbs <= MACRO_SUM_LIMIT, {
  message: 'Белков, жиров и углеводов вместе не может быть больше 100 г на 100 г',
});
export type PersonalFoodInput = z.infer<typeof PersonalFoodSchema>;

const same = (a: number | null, b: number, tol: number) => a != null && Math.abs(Number(a) - Number(b)) <= tol;

/**
 * Creates a personal food (label photo, typed label, the agent reading a label in the chat);
 * reuses an identical one instead of making duplicates.
 */
export async function createPersonalFood(sb: SupabaseClient, userId: string, b: PersonalFoodInput, origin: 'photo' | 'manual' | 'chat'): Promise<{ food: Food; created: boolean }> {
  const exactName = b.name.replace(/[\\%_]/g, (m) => `\\${m}`); // ilike without wildcards
  const { data: mine } = await sb.from('foods').select('*').eq('user_id', userId).is('archived_at', null).ilike('name_ru', exactName);
  const duplicate = ((mine ?? []) as Food[]).find((f) => same(f.kcal_100g, b.kcal, KCAL_TOLERANCE) && same(f.protein_100g, b.protein, MACRO_TOLERANCE)
    && same(f.fat_100g, b.fat, MACRO_TOLERANCE) && same(f.carbs_100g, b.carbs, MACRO_TOLERANCE));
  if (duplicate) {
    const patch = {
      ...(b.portion_g ? { default_portion_g: b.portion_g } : {}),
      ...(b.barcode && !duplicate.barcode ? { barcode: b.barcode } : {}),
    };
    if (!Object.keys(patch).length) return { food: duplicate, created: false };
    const { data } = await sb.from('foods').update(patch).eq('id', duplicate.id).select('*').single();
    return { food: (data as Food) ?? duplicate, created: false };
  }

  const notes = {
    photo: 'С этикетки: прочитано по фото, цифры проверены',
    manual: 'С этикетки, введено вручную',
    chat: 'С этикетки: прочитано в чате по фото',
  }[origin];
  const row = {
    user_id: userId, source: 'label', source_ref: b.recognition_id ?? null, barcode: b.barcode ?? null,
    name_ru: b.name, brand: b.brand || null, state: b.state,
    kcal_100g: b.kcal, protein_100g: b.protein, fat_100g: b.fat, carbs_100g: b.carbs, fiber_100g: b.fiber ?? null,
    default_portion_g: b.portion_g ?? null, confidence: 'high', notes,
  };
  const { data, error } = await sb.from('foods').insert(row).select('*').single();
  if (error?.code === '23505' && b.barcode) {
    const { data: byCode } = await sb.from('foods').select('*').eq('user_id', userId).eq('barcode', b.barcode).single();
    if (byCode) return { food: byCode as Food, created: false };
  }
  if (error || !data) throw new Error('Не удалось сохранить продукт');
  return { food: data as Food, created: true };
}

export type UserFoodOrigin = 'user' | 'label' | 'web';

export type SavedUserFood = { food: Food; created: boolean; replacedIds: string[]; numbers: UserFoodNumbers };

const ORIGIN_NOTE: Record<UserFoodOrigin, string> = {
  user: 'Со слов пользователя',
  label: 'С этикетки',
  web: 'Из интернета',
};

/** The row a personal food from stated numbers becomes (pure, shared with dry runs). */
export function userFoodRow(userId: string, input: UserFoodInput & { origin: UserFoodOrigin; source_ref?: string | null; category?: string | null }, numbers: UserFoodNumbers) {
  return {
    user_id: userId, source: input.origin, source_ref: input.source_ref ?? null,
    name_ru: cleanFoodName(input.name) || input.name.trim(), brand: input.brand?.trim() || null,
    category: input.category ?? (input.unit === 'ml' ? 'drinks' : null), state: 'as_is' as const,
    kcal_100g: numbers.per100.kcal, protein_100g: numbers.per100.protein, fat_100g: numbers.per100.fat, carbs_100g: numbers.per100.carbs,
    default_portion_g: numbers.portion.g, portions: [numbers.portion], confidence: numbers.confidence,
    notes: `${ORIGIN_NOTE[input.origin]}: ${numbers.note}`,
  };
}

/**
 * Saves a food from numbers the person stated (save_user_food, D24). One active row per
 * name + brand: the same numbers reuse it, different numbers archive the old row (history
 * stays) and add the new one, so later logs use what the person said last.
 */
export async function saveUserFood(
  sb: SupabaseClient, userId: string,
  input: UserFoodInput & { origin: UserFoodOrigin; source_ref?: string | null; category?: string | null },
  opts: { allowMismatch?: boolean } = {},
): Promise<SavedUserFood> {
  const numbers = userFoodNumbers(input, opts);
  const row = userFoodRow(userId, input, numbers);
  const key = foodKey(row.name_ru, row.brand);
  const exactName = row.name_ru.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data: mine, error: readErr } = await sb.from('foods').select('*').eq('user_id', userId).is('archived_at', null)
    .in('source', ['user', 'web', 'label']).ilike('name_ru', exactName);
  if (readErr) throw new Error(`foods: ${readErr.message}`);
  const same = ((mine ?? []) as Food[]).filter((f) => foodKey(f.name_ru, f.brand) === key);
  const identical = same.find((f) => sameNumbers(
    { kcal: Number(f.kcal_100g), protein: f.protein_100g == null ? null : Number(f.protein_100g), fat: f.fat_100g == null ? null : Number(f.fat_100g), carbs: f.carbs_100g == null ? null : Number(f.carbs_100g) },
    numbers.per100,
  ));
  if (identical) return { food: identical, created: false, replacedIds: [], numbers };
  const replacedIds = same.map((f) => f.id);
  if (replacedIds.length) {
    const { error } = await sb.from('foods').update({ archived_at: new Date().toISOString() }).in('id', replacedIds).eq('user_id', userId);
    if (error) throw new Error(`foods archive: ${error.message}`);
  }
  const { data, error } = await sb.from('foods').insert(row).select('*').single();
  if (error?.code === '23505') {
    // A parallel save of the same name + brand won the race: use its row.
    const { data: winner } = await sb.from('foods').select('*').eq('user_id', userId).is('archived_at', null).ilike('name_ru', exactName);
    const found = ((winner ?? []) as Food[]).find((f) => foodKey(f.name_ru, f.brand) === key);
    if (found) return { food: found, created: false, replacedIds, numbers };
  }
  if (error || !data) throw new Error(`foods insert: ${error?.code ?? 'no row'}`);
  return { food: data as Food, created: true, replacedIds, numbers };
}
