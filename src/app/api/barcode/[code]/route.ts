import { handler, HttpError, json, requireUser } from '@/lib/http';

// Open Food Facts lookup (ODbL). Their policy asks for a descriptive User-Agent; we use
// a generic app name without personal data. Found products are saved as personal foods.
export const GET = handler(async (req, ctx: { params: Promise<{ code: string }> }) => {
  const { userId, sb } = await requireUser(req);
  const { code } = await ctx.params;
  if (!/^\d{8,14}$/.test(code)) throw new HttpError(400, 'Штрихкод — это 8–14 цифр', 'validation');

  const { data: existing } = await sb.from('foods').select('*').eq('barcode', code).or(`user_id.is.null,user_id.eq.${userId}`).limit(1);
  if (existing?.length) return json({ food: existing[0] });

  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_ru,brands,nutriments,serving_quantity`, {
    headers: { 'User-Agent': 'RyadomNutritionPWA/1.0 (personal open-source app)' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res || !res.ok) return json({ food: null, message: 'Open Food Facts не ответил. Попробуй позже или создай продукт по этикетке.' });
  const body = (await res.json()) as { status?: number; product?: { product_name?: string; product_name_ru?: string; brands?: string; serving_quantity?: number; nutriments?: Record<string, number> } };
  const p = body.product;
  const n = p?.nutriments ?? {};
  const kcal = n['energy-kcal_100g'] ?? (n['energy_100g'] ? n['energy_100g'] / 4.184 : undefined);
  if (!p || body.status === 0 || kcal == null) return json({ food: null, message: 'Нашёл товар, но без КБЖУ — внеси по этикетке.' });
  const row = {
    user_id: userId, source: 'off', source_ref: code, barcode: code,
    name_ru: (p.product_name_ru || p.product_name || `Товар ${code}`).slice(0, 160), brand: p.brands?.slice(0, 80) ?? null,
    state: 'as_is', kcal_100g: Math.round(kcal * 10) / 10, protein_100g: n['proteins_100g'] ?? 0, fat_100g: n['fat_100g'] ?? 0,
    carbs_100g: n['carbohydrates_100g'] ?? 0, fiber_100g: n['fiber_100g'] ?? null, default_portion_g: p.serving_quantity ?? 100,
    confidence: 'medium', notes: 'Open Food Facts (ODbL), данные краудсорсинговые — сверь с упаковкой',
  };
  const { data, error } = await sb.from('foods').insert(row).select('*').single();
  if (error) throw new HttpError(500, 'Не удалось сохранить продукт', 'db');
  return json({ food: data });
});
