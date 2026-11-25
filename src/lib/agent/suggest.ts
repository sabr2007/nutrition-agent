import type { SupabaseClient } from '@supabase/supabase-js';
import { macrosFor, per100Of, r1 } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';
import { getDaySummary, type DaySummary } from '@/lib/data/day';
import type { Profile } from '@/lib/data/profile';

// «Что съесть» (D27): deterministic options in grams with macros from the food base, ranked by
// protein per 100 kcal among those that fit the calories left today. Usual foods (templates,
// history) and what the memory says is at home come first among equals; dislikes are out.

/** Practical protein sources with realistic serving steps; matched by base food keys. */
export const CANDIDATES: { source: string; ref: string; step: number; min: number; max: number; unit?: string; night?: boolean }[] = [
  { source: 'usda_sr', ref: '05062', step: 50, min: 100, max: 300 },           // chicken breast raw
  { source: 'ru_table', ref: 'ru:tvorog_2', step: 50, min: 100, max: 400, night: true },
  { source: 'ru_table', ref: 'ru:tvorog_5', step: 50, min: 100, max: 400, night: true },
  { source: 'seed', ref: 'seed:whey_generic', step: 30, min: 30, max: 60, unit: 'скуп', night: true },
  { source: 'usda_sr', ref: '01123', step: 52, min: 104, max: 260, unit: 'шт' }, // eggs
  { source: 'ru_table', ref: 'ru:kefir_1', step: 250, min: 250, max: 500, night: true },
  { source: 'usda_sr', ref: '01287', step: 50, min: 150, max: 300, night: true }, // greek yogurt
  { source: 'seed', ref: 'seed:tuna_water', step: 70, min: 70, max: 140 },
  { source: 'usda_sr', ref: '01124', step: 33, min: 99, max: 264, unit: 'белок' },
];

export type Suggestion = {
  title: string;
  items: { food_id: string; name: string; grams: number; portion?: string }[];
  kcal: number; protein_g: number; fat_g: number; carbs_g: number;
  protein_per_100kcal: number;
  usual?: boolean;
};

/** Base candidate foods with their serving rules. */
export async function loadCandidates(sb: SupabaseClient): Promise<{ food: Food; rule: (typeof CANDIDATES)[number] }[]> {
  const { data } = await sb.from('foods').select('*').is('user_id', null).in('source_ref', CANDIDATES.map((c) => c.ref));
  const byRef = new Map(((data ?? []) as (Food & { source_ref: string })[]).map((f) => [f.source_ref, f]));
  return CANDIDATES.flatMap((rule) => (byRef.get(rule.ref) ? [{ food: byRef.get(rule.ref)!, rule }] : []));
}

const density = (o: { protein_g: number; kcal: number }) => (o.kcal > 0 ? r1((o.protein_g / o.kcal) * 100) : 0);

/** Pure ranking: within budget first, then protein per 100 kcal, then usual foods, then fewer calories. */
export function rankSuggestions(options: Suggestion[], budget: number): Suggestion[] {
  const fits = (o: Suggestion) => budget < 150 || o.kcal <= budget;
  return [...options].sort((a, b) =>
    Number(fits(b)) - Number(fits(a))
    || b.protein_per_100kcal - a.protein_per_100kcal
    || Number(Boolean(b.usual)) - Number(Boolean(a.usual))
    || a.kcal - b.kcal);
}

export async function suggestForRemaining(
  sb: SupabaseClient, userId: string, profile: Profile,
  args: { protein_g?: number; kcal_max?: number; before_sleep?: boolean },
  summary?: DaySummary,
): Promise<{ target_protein_g: number; kcal_budget: number; training_day: boolean; options: Suggestion[]; note?: string }> {
  const s = summary ?? (await getDaySummary(sb, userId, undefined, profile));
  const target = Math.max(0, args.protein_g ?? s.remaining?.protein_to_min ?? 40);
  const budget = Math.max(0, args.kcal_max ?? s.remaining?.kcal_to_max ?? 600);
  if (target <= 0) return { target_protein_g: 0, kcal_budget: budget, training_day: s.trainingDay, options: [], note: 'Белок уже добран.' };

  const [candidates, usualRes, homeRes] = await Promise.all([
    loadCandidates(sb),
    sb.from('meal_template_items').select('food_id').eq('user_id', userId),
    sb.from('memories').select('content').eq('user_id', userId).eq('status', 'active').or('content.ilike.*дома*,content.ilike.*холодильник*,content.ilike.*купил*').limit(10),
  ]);
  const usual = new Set((usualRes.data ?? []).map((r) => r.food_id as string));
  const atHome = (homeRes.data ?? []).map((m) => String(m.content).toLowerCase()).join(' ');
  const disliked = (profile.dislikes ?? []).join(' ').toLowerCase();

  const singles: Suggestion[] = [];
  for (const { food: f, rule: c } of candidates) {
    const head = f.name_ru.toLowerCase().split(/[\s,(]/)[0];
    if (disliked.includes(head)) continue;
    if (args.before_sleep && !c.night) continue;
    const per = per100Of(f);
    if (per.protein <= 0) continue;
    // Enough to close the gap, but never past the calories left (when anything is left).
    let grams = Math.ceil(target / (per.protein / 100) / c.step) * c.step;
    if (budget >= 150) grams = Math.min(grams, Math.floor(budget / (per.kcal / 100) / c.step) * c.step);
    grams = Math.min(c.max, Math.max(c.min, grams));
    const m = macrosFor(grams, per);
    const portion = c.unit ? `${Math.round(grams / c.step)} ${c.unit}` : undefined;
    singles.push({
      title: f.name_ru, items: [{ food_id: f.id, name: f.name_ru, grams, portion }], ...m,
      protein_per_100kcal: density(m), usual: usual.has(f.id) || (head.length > 3 && atHome.includes(head.slice(0, 5))),
    });
  }
  // Two-item combos close a large gap with smaller, more realistic portions.
  const combos: Suggestion[] = [];
  if (target > 45) {
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        const [a, b] = [singles[i], singles[j]];
        const fa = candidates.find((x) => x.food.id === a.items[0].food_id)!;
        const fb = candidates.find((x) => x.food.id === b.items[0].food_id)!;
        const ga = Math.max(fa.rule.min, Math.round((a.items[0].grams * 0.5) / fa.rule.step) * fa.rule.step);
        const gb = Math.max(fb.rule.min, Math.round((b.items[0].grams * 0.5) / fb.rule.step) * fb.rule.step);
        const ma = macrosFor(ga, per100Of(fa.food));
        const mb = macrosFor(gb, per100Of(fb.food));
        const m = { kcal: r1(ma.kcal + mb.kcal), protein_g: r1(ma.protein_g + mb.protein_g), fat_g: r1(ma.fat_g + mb.fat_g), carbs_g: r1(ma.carbs_g + mb.carbs_g) };
        combos.push({
          title: `${fa.food.name_ru} + ${fb.food.name_ru}`,
          items: [{ food_id: fa.food.id, name: fa.food.name_ru, grams: ga }, { food_id: fb.food.id, name: fb.food.name_ru, grams: gb }],
          ...m, protein_per_100kcal: density(m), usual: Boolean(a.usual || b.usual),
        });
      }
    }
  }
  const options = rankSuggestions([...singles, ...combos], budget).slice(0, 3);
  const note = budget < 150 ? 'Калорий почти не осталось: выбирай самое постное (белок/творог 0–2%).' : undefined;
  return { target_protein_g: Math.round(target), kcal_budget: Math.round(budget), training_day: s.trainingDay, options, note };
}
