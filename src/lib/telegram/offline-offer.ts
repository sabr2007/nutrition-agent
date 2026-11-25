import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listTemplates } from '@/lib/data/meals';
import { macrosFor } from '@/lib/nutrition/calc';
import { personalContext, quickMatch } from '@/lib/recognition/pipeline';
import { MAX_OFFLINE_TEMPLATES, type OfflineOffer } from './offline';

/** What the bot can still do without the agent: the quick parser's reading of the text and templates. */
export async function offlineOffer(sb: SupabaseClient, userId: string, text: string): Promise<OfflineOffer> {
  const [quick, templates] = await Promise.all([
    text.trim()
      ? personalContext(sb, userId).then((ctx) => quickMatch(sb, text, ctx.preferred)).catch(() => null)
      : Promise.resolve(null),
    listTemplates(sb, userId).catch(() => []),
  ]);
  return {
    quick: quick?.length
      ? {
          title: quick.map((q) => `${q.food.name_ru} ${Math.round(q.grams)} г`).join(', '),
          kcal: Math.round(quick.reduce((sum, q) => sum + macrosFor(q.grams, { kcal: Number(q.food.kcal_100g), protein: Number(q.food.protein_100g), fat: Number(q.food.fat_100g), carbs: Number(q.food.carbs_100g) }).kcal, 0)),
          items: quick.map((q) => ({ food_id: q.food.id, name: q.food.name_ru, grams: Math.round(q.grams) })),
        }
      : null,
    templates: templates.slice(0, MAX_OFFLINE_TEMPLATES).map((t) => ({ id: t.id, name: t.name, kcal: t.kcal })),
  };
}
