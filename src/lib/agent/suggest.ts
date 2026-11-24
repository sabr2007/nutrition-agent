import type { SupabaseClient } from '@supabase/supabase-js';
import { macrosFor, r1 } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';
import { getDaySummary } from '@/lib/data/day';
import type { Profile } from '@/lib/data/profile';

// Practical protein sources with realistic serving steps; matched by base food keys.
const CANDIDATES: { source: string; ref: string; step: number; min: number; max: number; unit?: string; night?: boolean }[] = [
  { source: 'usda_sr', ref: '05062', step: 50, min: 100, max: 300 },           // chicken breast raw
  { source: 'ru_table', ref: 'ru:tvorog_2', step: 100, min: 100, max: 400, night: true },
  { source: 'seed', ref: 'seed:whey_generic', step: 30, min: 30, max: 60, unit: 'скуп', night: true },
  { source: 'usda_sr', ref: '01123', step: 52, min: 104, max: 260, unit: 'шт' }, // eggs
  { source: 'ru_table', ref: 'ru:kefir_1', step: 250, min: 250, max: 500, night: true },
  { source: 'usda_sr', ref: '01287', step: 50, min: 150, max: 300, night: true }, // greek yogurt
  { source: 'seed', ref: 'seed:tuna_water', step: 70, min: 70, max: 140 },
  { source: 'usda_sr', ref: '01124', step: 33, min: 99, max: 264, unit: 'белок' },
];

export type Suggestion = { title: string; items: { food_id: string; name: string; grams: number; portion?: string }[]; kcal: number; protein_g: number; fat_g: number; carbs_g: number };

export async function suggestForRemaining(
  sb: SupabaseClient, userId: string, profile: Profile,
  args: { protein_g?: number; kcal_max?: number; before_sleep?: boolean },
): Promise<{ target_protein_g: number; kcal_budget: number; options: Suggestion[]; note?: string }> {
  const s = await getDaySummary(sb, userId, undefined, profile);
  const target = Math.max(0, args.protein_g ?? s.remaining?.protein_to_min ?? 40);
  const budget = Math.max(0, args.kcal_max ?? s.remaining?.kcal_to_max ?? 600);
  if (target <= 0) return { target_protein_g: 0, kcal_budget: budget, options: [], note: 'Белок уже добран.' };

  const { data } = await sb.from('foods').select('*').is('user_id', null)
    .in('source_ref', CANDIDATES.map((c) => c.ref));
  const foods = new Map(((data ?? []) as (Food & { source_ref: string })[]).map((f) => [f.source_ref, f]));
  const disliked = (profile.dislikes ?? []).join(' ').toLowerCase();

  const singles: Suggestion[] = [];
  for (const c of CANDIDATES) {
    const f = foods.get(c.ref);
    if (!f || disliked.includes(f.name_ru.toLowerCase().split(' ')[0])) continue;
    if (args.before_sleep && !c.night) continue;
    const per = Number(f.protein_100g) / 100;
    if (per <= 0) continue;
    let grams = Math.ceil(target / per / c.step) * c.step;
    grams = Math.min(c.max, Math.max(c.min, grams));
    const m = macrosFor(grams, { kcal: Number(f.kcal_100g), protein: Number(f.protein_100g), fat: Number(f.fat_100g), carbs: Number(f.carbs_100g) });
    const portion = c.unit ? `${Math.round(grams / c.step)} ${c.unit}` : undefined;
    singles.push({ title: f.name_ru, items: [{ food_id: f.id, name: f.name_ru, grams, portion }], ...m });
  }
  // Two-item combos close a large gap with smaller, more realistic portions.
  const combos: Suggestion[] = [];
  if (target > 45) {
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        const a = singles[i]; const b = singles[j];
        const ga = Math.max(CANDIDATES[0].step, Math.round(a.items[0].grams * 0.5));
        const gb = Math.max(30, Math.round(b.items[0].grams * 0.5));
        const fa = foods.get([...foods.entries()].find(([, v]) => v.id === a.items[0].food_id)![0])!;
        const fb = foods.get([...foods.entries()].find(([, v]) => v.id === b.items[0].food_id)![0])!;
        const ma = macrosFor(ga, { kcal: Number(fa.kcal_100g), protein: Number(fa.protein_100g), fat: Number(fa.fat_100g), carbs: Number(fa.carbs_100g) });
        const mb = macrosFor(gb, { kcal: Number(fb.kcal_100g), protein: Number(fb.protein_100g), fat: Number(fb.fat_100g), carbs: Number(fb.carbs_100g) });
        combos.push({
          title: `${fa.name_ru} + ${fb.name_ru}`,
          items: [{ food_id: fa.id, name: fa.name_ru, grams: ga }, { food_id: fb.id, name: fb.name_ru, grams: gb }],
          kcal: r1(ma.kcal + mb.kcal), protein_g: r1(ma.protein_g + mb.protein_g), fat_g: r1(ma.fat_g + mb.fat_g), carbs_g: r1(ma.carbs_g + mb.carbs_g),
        });
      }
    }
  }
  const score = (o: Suggestion) => {
    const miss = Math.max(0, target - o.protein_g);
    const over = Math.max(0, o.kcal - budget);
    return miss * 3 + over * 0.5 + o.kcal * 0.05 + o.fat_g * 0.5;
  };
  const options = [...singles, ...combos].sort((x, y) => score(x) - score(y)).slice(0, 3);
  const note = budget < 150 ? 'Калорий почти не осталось: выбирай самое постное (белок/творог 0–2%).' : undefined;
  return { target_protein_g: Math.round(target), kcal_budget: Math.round(budget), options, note };
}
