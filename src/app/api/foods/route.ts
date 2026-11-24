import { z } from 'zod';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import type { Food } from '@/lib/nutrition/types';

const MACRO_SUM_LIMIT = 100.5;

const Body = z.object({
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

const same = (a: number, b: number, tol: number) => Math.abs(Number(a) - Number(b)) <= tol;

/** Creates a personal food from a label (photo-read or typed); reuses an identical one. */
export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Проверь цифры', 'validation');
  const b = parsed.data;

  const exactName = b.name.replace(/[\\%_]/g, (m) => `\\${m}`); // ilike without wildcards
  const { data: mine } = await sb.from('foods').select('*').eq('user_id', userId).is('archived_at', null).ilike('name_ru', exactName);
  const duplicate = ((mine ?? []) as Food[]).find((f) => same(f.kcal_100g, b.kcal, 0.6) && same(f.protein_100g, b.protein, 0.15)
    && same(f.fat_100g, b.fat, 0.15) && same(f.carbs_100g, b.carbs, 0.15));
  if (duplicate) {
    const patch = {
      ...(b.portion_g ? { default_portion_g: b.portion_g } : {}),
      ...(b.barcode && !duplicate.barcode ? { barcode: b.barcode } : {}),
    };
    if (!Object.keys(patch).length) return json({ food: duplicate, created: false });
    const { data } = await sb.from('foods').update(patch).eq('id', duplicate.id).select('*').single();
    return json({ food: data ?? duplicate, created: false });
  }

  const row = {
    user_id: userId, source: 'label', source_ref: b.recognition_id ?? null, barcode: b.barcode ?? null,
    name_ru: b.name, brand: b.brand || null, state: b.state,
    kcal_100g: b.kcal, protein_100g: b.protein, fat_100g: b.fat, carbs_100g: b.carbs, fiber_100g: b.fiber ?? null,
    default_portion_g: b.portion_g ?? null, confidence: 'high',
    notes: b.recognition_id ? 'С этикетки: прочитано по фото, цифры проверены' : 'С этикетки, введено вручную',
  };
  const { data, error } = await sb.from('foods').insert(row).select('*').single();
  if (error?.code === '23505' && b.barcode) {
    const { data: byCode } = await sb.from('foods').select('*').eq('user_id', userId).eq('barcode', b.barcode).single();
    if (byCode) return json({ food: byCode, created: false });
  }
  if (error || !data) throw new HttpError(500, 'Не удалось сохранить продукт', 'db');
  return json({ food: data, created: true });
});
