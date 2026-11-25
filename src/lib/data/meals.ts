import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { extrasFor, itemFromFood, macrosFor, r1 } from '@/lib/nutrition/calc';
import type { Food, MealItemInput } from '@/lib/nutrition/types';
import { localDay } from '@/lib/nutrition/day';
import { getProfile, isTrainingDay } from './profile';

export const MealItemSchema = z.object({
  food_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  grams: z.number().min(0).max(5000),
  state: z.enum(['raw', 'cooked', 'dry', 'as_is']).nullable().optional(),
  per100: z.object({ kcal: z.number().min(0).max(1000), protein: z.number().min(0).max(100), fat: z.number().min(0).max(100), carbs: z.number().min(0).max(100), partial: z.boolean().optional(), satfat: z.number().min(0).max(100).nullable().optional(), sugar: z.number().min(0).max(100).nullable().optional() }).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  source: z.enum(['model', 'user', 'template', 'scale', 'barcode', 'agent', 'repeat']).default('user'),
  model_grams: z.number().nullable().optional(),
  model_label: z.string().max(200).nullable().optional(),
  edited: z.boolean().optional(),
});

export const SaveMealSchema = z.object({
  supersedes_id: z.string().uuid().nullable().optional(),
  eaten_at: z.string().datetime({ offset: true }).optional(),
  slot: z.string().max(30).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  input_method: z.enum(['template', 'text', 'photo', 'voice', 'barcode', 'repeat', 'manual', 'agent', 'scale', 'import', 'label']),
  template_id: z.string().uuid().nullable().optional(),
  recognition_id: z.string().uuid().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  is_labeled: z.boolean().optional(),
  time_to_confirm_ms: z.number().int().min(0).max(86_400_000).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  client_id: z.string().max(80).nullable().optional(),
  items: z.array(MealItemSchema).min(1).max(30),
});
export type SaveMealInput = z.infer<typeof SaveMealSchema>;

const SLOT_CHECKLIST: Record<string, string> = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner' };

/** Never trust client-side numbers: recompute macros from the food table when possible. */
async function recomputeItems(sb: SupabaseClient, items: SaveMealInput['items']): Promise<MealItemInput[]> {
  const ids = [...new Set(items.map((i) => i.food_id).filter((x): x is string => Boolean(x)))];
  const foods = new Map<string, Food>();
  if (ids.length) {
    const { data, error } = await sb.from('foods').select('*').in('id', ids);
    if (error) throw new Error(`foods: ${error.message}`);
    for (const f of data ?? []) foods.set(f.id as string, f as Food);
  }
  return items.map((it) => {
    const food = it.food_id ? foods.get(it.food_id) : undefined;
    if (food) {
      return itemFromFood(food, it.grams, {
        source: it.source, confidence: it.confidence ?? null, model_grams: it.model_grams ?? null,
        model_label: it.model_label ?? null, name: it.name || food.name_ru, edited: it.edited,
      });
    }
    if (!it.per100) throw new Error(`Нет данных о калорийности для «${it.name}»`);
    return {
      food_id: null, name: it.name, grams: r1(it.grams), state: it.state ?? null, per100: it.per100,
      ...macrosFor(it.grams, it.per100), ...extrasFor(it.grams, it.per100), confidence: it.confidence ?? null, source: it.source,
      model_grams: it.model_grams ?? null, model_label: it.model_label ?? null, edited: it.edited ?? false,
    };
  });
}

export async function markChecklist(sb: SupabaseClient, userId: string, day: string, key: string, done: boolean, source: 'user' | 'auto' | 'agent' | 'import' = 'auto', value: number | null = null) {
  const { error } = await sb.from('checklist_marks').insert({ user_id: userId, local_day: day, item_key: key, done, value, source });
  if (error) throw new Error(`checklist: ${error.message}`);
}

export type SavedMeal = { id: string; root_id: string; local_day: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; satfat_g: number | null; checklist: string[] };

export async function saveMeal(sb: SupabaseClient, userId: string, input: SaveMealInput, extra: { checklistKey?: string | null } = {}): Promise<SavedMeal> {
  const items = await recomputeItems(sb, input.items);
  const payload = { ...input, items };
  const { data, error } = await sb.rpc('save_meal', { p: payload });
  if (error) throw new Error(`save_meal: ${error.message}`);
  const meal = data as { id: string; root_id: string; local_day: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; satfat_g: number | null; slot: string | null };

  // Auto-check the matching checklist items (template key, or slot for free-form meals).
  const keys = new Set<string>();
  if (extra.checklistKey) keys.add(extra.checklistKey);
  if (!input.supersedes_id && meal.slot && SLOT_CHECKLIST[meal.slot]) keys.add(SLOT_CHECKLIST[meal.slot]);
  if (!input.supersedes_id) {
    for (const it of items) {
      if (/протеин|whey/i.test(it.name)) {
        // first shake of the day → protein_1, second → protein_2
        const { data: st } = await sb.from('checklist_state').select('item_key, done').eq('user_id', userId).eq('local_day', meal.local_day).in('item_key', ['protein_1', 'protein_2']);
        const done = new Set((st ?? []).filter((x) => x.done).map((x) => x.item_key as string));
        if (!extra.checklistKey?.startsWith('protein')) keys.add(done.has('protein_1') ? 'protein_2' : 'protein_1');
      }
      if (/креатин/i.test(it.name)) keys.add('creatine');
      if (/творог/i.test(it.name) && meal.slot === 'late') keys.add('tvorog');
    }
  }
  for (const k of keys) await markChecklist(sb, userId, meal.local_day, k, true, 'auto');

  // Diff between model output and what the user confirmed → personal calibration data.
  if (input.recognition_id) {
    const corrections = items
      .filter((it) => it.source === 'model' && it.model_grams != null && Math.abs(Number(it.model_grams) - it.grams) >= 1)
      .map((it) => ({
        user_id: userId, meal_id: meal.id, recognition_id: input.recognition_id, kind: 'grams', item_label: it.model_label ?? it.name,
        food_id_after: it.food_id, grams_before: it.model_grams, grams_after: it.grams,
        diff: { name: it.name, ratio: it.grams / Number(it.model_grams) },
      }));
    if (corrections.length) await sb.from('meal_corrections').insert(corrections);
  }
  return {
    id: meal.id, root_id: meal.root_id, local_day: meal.local_day,
    kcal: Number(meal.kcal), protein_g: Number(meal.protein_g), fat_g: Number(meal.fat_g), carbs_g: Number(meal.carbs_g),
    satfat_g: meal.satfat_g != null ? Number(meal.satfat_g) : null,
    checklist: [...keys],
  };
}

export type TemplateRow = {
  id: string; key: string | null; name: string; slot: string; default_time: string | null; checklist_key: string | null;
  training_day_only: boolean; glyph: string | null; sort_order: number;
  items: { food_id: string; grams: number; note: string | null; foods: Food }[];
};

export async function listTemplates(sb: SupabaseClient, userId: string): Promise<(TemplateRow & { kcal: number; protein_g: number; fat_g: number; carbs_g: number })[]> {
  const { data, error } = await sb.from('meal_templates')
    .select('id, key, name, slot, default_time, checklist_key, training_day_only, glyph, sort_order, items:meal_template_items(food_id, grams, note, sort_order, foods(*))')
    .eq('user_id', userId).is('archived_at', null).order('sort_order');
  if (error) throw new Error(`templates: ${error.message}`);
  return ((data ?? []) as unknown as TemplateRow[]).map((t) => {
    const totals = t.items.reduce((a, it) => {
      const m = macrosFor(Number(it.grams), { kcal: Number(it.foods.kcal_100g), protein: Number(it.foods.protein_100g), fat: Number(it.foods.fat_100g), carbs: Number(it.foods.carbs_100g) });
      return { kcal: a.kcal + m.kcal, protein_g: a.protein_g + m.protein_g, fat_g: a.fat_g + m.fat_g, carbs_g: a.carbs_g + m.carbs_g };
    }, { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
    return { ...t, default_time: t.default_time?.slice(0, 5) ?? null, kcal: Math.round(totals.kcal), protein_g: r1(totals.protein_g), fat_g: r1(totals.fat_g), carbs_g: r1(totals.carbs_g) };
  });
}

/** One-tap logging of a template (the "breakfast as usual" path). */
export async function logTemplate(sb: SupabaseClient, userId: string, args: { templateId: string; eatenAt?: string; clientId?: string | null; scale?: number }): Promise<SavedMeal & { name: string }> {
  const { data: t, error } = await sb.from('meal_templates')
    .select('id, name, slot, checklist_key, items:meal_template_items(food_id, grams, sort_order, foods(*))')
    .eq('id', args.templateId).eq('user_id', userId).single();
  if (error || !t) throw new Error('Шаблон не найден');
  const scale = args.scale && args.scale > 0 ? args.scale : 1;
  const items = ((t.items ?? []) as unknown as { food_id: string; grams: number; sort_order: number; foods: Food }[])
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((it) => ({ food_id: it.food_id, name: it.foods.name_ru, grams: r1(Number(it.grams) * scale), source: 'template' as const }));
  const saved = await saveMeal(sb, userId, {
    eaten_at: args.eatenAt ?? new Date().toISOString(),
    slot: t.slot as string, title: t.name as string, input_method: 'template', template_id: t.id as string,
    client_id: args.clientId ?? null, items, confidence: 1,
  }, { checklistKey: t.checklist_key as string | null });
  return { ...saved, name: t.name as string };
}

/** Copies yesterday's (or any day's) meal as a new one now ("повторить"). */
export async function repeatMeal(sb: SupabaseClient, userId: string, mealId: string, eatenAt?: string): Promise<SavedMeal> {
  const { data: m, error } = await sb.from('meals').select('id, slot, title, template_id, meal_items(food_id, name, grams, per100, state)').eq('id', mealId).eq('user_id', userId).single();
  if (error || !m) throw new Error('Приём не найден');
  const items = ((m.meal_items ?? []) as { food_id: string | null; name: string; grams: number; per100: MealItemInput['per100']; state: string | null }[])
    .map((it) => ({ food_id: it.food_id, name: it.name, grams: Number(it.grams), per100: it.per100, source: 'repeat' as const }));
  return saveMeal(sb, userId, { eaten_at: eatenAt ?? new Date().toISOString(), slot: m.slot as string, title: m.title as string, input_method: 'repeat', template_id: m.template_id as string | null, items });
}

export async function dayForInstant(sb: SupabaseClient, userId: string, iso: string): Promise<{ day: string; training: boolean }> {
  const p = await getProfile(sb, userId);
  const day = localDay(new Date(iso), p.timezone, p.day_boundary_minutes);
  return { day, training: isTrainingDay(p, day) };
}
