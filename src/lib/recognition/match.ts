import type { SupabaseClient } from '@supabase/supabase-js';
import type { Food, FoodState } from '@/lib/nutrition/types';

export async function searchFoods(sb: SupabaseClient, q: string, limit = 8): Promise<Food[]> {
  const query = q.trim();
  if (!query) return [];
  const { data, error } = await sb.rpc('search_foods', { q: query, lim: limit });
  if (error) throw new Error(`search_foods failed: ${error.message}`);
  return (data ?? []) as Food[];
}

/** search_foods scores are ~0.5 (weak) … 2.5 (exact); map to 0.4 … 1. */
export function matchQuality(score: number | undefined): number {
  if (score == null) return 0.5;
  return Math.max(0.4, Math.min(1, score / 1.3));
}

/**
 * Picks the best food for a recognized item: prefer the recognized state (cooked vs raw)
 * among results whose score is close to the top one.
 */
const FAT_WORDS = /масл|жир|сало|oil|butter|lard|маргарин|майонез|сливоч/i;
const SAUCE_WORDS = /заправ|соус|майонез|кетчуп|dressing|sauce|винегрет/i;

/**
 * Guard against dangerous fuzzy matches: an energy-dense fat (≈ 900 kcal/100 g) must only
 * match when the query actually names a fat ("оливки" must never become olive oil).
 */
export function plausible(food: Food, query: string | undefined): boolean {
  if (!query) return true;
  const dense = Number(food.kcal_100g) >= 600 && (food.category === 'fats' || Number(food.fat_100g) >= 60);
  if (dense && !FAT_WORDS.test(query)) return false;
  // Calorie-dense sauces/dressings only when the query names a sauce ("салат цезарь" ≠ dressing).
  if (food.category === 'sauces' && Number(food.kcal_100g) >= 250 && !SAUCE_WORDS.test(query)) return false;
  return true;
}

export function pickBest(
  results: Food[],
  state: FoodState | null | undefined,
  preferred?: Map<string, number>,
  query?: string,
): { food: Food; quality: number } | null {
  results = results.filter((f) => plausible(f, query));
  if (!results.length) return null;
  const top = results[0];
  const topScore = top.score ?? 1;
  // Personal habits win among close matches: the foods in the user's templates/history
  // (e.g. raw chicken breast for someone who weighs raw) when no state was given.
  if (preferred?.size && (!state || state === 'as_is')) {
    const close = results.filter((f) => (f.score ?? 0) >= topScore * 0.7 && preferred.has(f.id));
    if (close.length) {
      const fav = close.reduce((a, b) => ((preferred.get(b.id) ?? 0) > (preferred.get(a.id) ?? 0) ? b : a));
      return { food: fav, quality: Math.max(matchQuality(fav.score), 0.8) };
    }
  }
  if (state && state !== 'as_is' && top.state !== state) {
    const sameState = results.find((f) => f.state === state && (f.score ?? 0) >= topScore * 0.75);
    if (sameState) return { food: sameState, quality: matchQuality(sameState.score) };
  }
  return { food: top, quality: matchQuality(top.score) };
}

const STOP = new Set(['из', 'с', 'со', 'и', 'в', 'на', 'без', 'под', 'по', 'для', 'с/без']);

/** Progressively simpler queries for items the full query didn't match. */
export function fallbackQueries(q: string): string[] {
  const words = normalizeQuery(q).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
  const out: string[] = [];
  if (words.length > 1) out.push(words.slice(0, 2).join(' '));
  for (const w of [...words].sort((a, b) => b.length - a.length)) out.push(w);
  return [...new Set(out)].slice(0, 4);
}

/** search_foods with fallbacks; returns the first non-empty result set. */
export async function searchFoodsSmart(sb: SupabaseClient, q: string, limit = 6): Promise<Food[]> {
  const first = await searchFoods(sb, q, limit);
  if (first.length && (first[0].score ?? 0) >= 0.6) return first;
  for (const alt of fallbackQueries(q)) {
    const res = await searchFoods(sb, alt, limit);
    if (res.length && (res[0].score ?? 0) >= 0.9) return res.map((f) => ({ ...f, score: (f.score ?? 1) * 0.8 }));
  }
  return first;
}

export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}% ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
