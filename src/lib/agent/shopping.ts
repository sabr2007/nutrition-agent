import type { SupabaseClient } from '@supabase/supabase-js';
import { listTemplates } from '@/lib/data/meals';
import { addDays } from '@/lib/nutrition/day';
import { isTrainingDay, type Profile } from '@/lib/data/profile';

const PACKS: { match: RegExp; unit: string; size: number; label: string }[] = [
  { match: /^Яйцо куриное/, unit: 'шт', size: 52, label: 'яйца (упаковки по 10)' },
  { match: /^Творог/, unit: 'пачка', size: 200, label: 'пачки по 200 г' },
  { match: /Протеин/, unit: 'скуп', size: 30, label: 'скупов (проверь банку)' },
  { match: /^Банан/, unit: 'шт', size: 118, label: 'шт' },
];

export async function buildShoppingList(sb: SupabaseClient, userId: string, profile: Profile, days: number, start: string, save: boolean) {
  const templates = await listTemplates(sb, userId);
  const totals = new Map<string, { name: string; category: string | null; grams: number }>();
  let trainingDays = 0;
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const training = isTrainingDay(profile, day);
    if (training) trainingDays++;
    for (const t of templates) {
      if (!t.default_time) continue; // only the regular daily schedule
      if (t.training_day_only && !training) continue;
      for (const it of t.items) {
        const cur = totals.get(it.food_id) ?? { name: it.foods.name_ru, category: it.foods.category ?? null, grams: 0 };
        cur.grams += Number(it.grams);
        totals.set(it.food_id, cur);
      }
    }
  }
  const items = [...totals.values()].filter((x) => !/Креатин/.test(x.name)).map((x) => {
    const pack = PACKS.find((p) => p.match.test(x.name));
    if (pack) {
      const n = Math.ceil(x.grams / pack.size);
      return { name: x.name, category: x.category, amount: n, unit: pack.unit, note: pack.label, grams: Math.round(x.grams) };
    }
    const kg = x.grams >= 1000;
    return { name: x.name, category: x.category, amount: kg ? Math.ceil(x.grams / 100) / 10 : Math.ceil(x.grams / 50) * 50, unit: kg ? 'кг' : 'г', note: /сыр|фил/i.test(x.name) ? 'сырой вес' : null, grams: Math.round(x.grams) };
  }).sort((a, b) => String(a.category).localeCompare(String(b.category)));
  let listId: string | null = null;
  if (save) {
    const { data } = await sb.from('shopping_lists').insert({ user_id: userId, days, items, note: `с ${start}, дней тренировок: ${trainingDays}` }).select('id').single();
    listId = (data?.id as string) ?? null;
  }
  // Store preferences live in the user's memory/profile, never in code.
  return { list_id: listId, days, start, training_days: trainingDays, items, budget_notes: profile.budget_notes };
}
