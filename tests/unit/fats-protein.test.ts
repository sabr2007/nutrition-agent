import { describe, expect, test } from 'vitest';
import { dayProgress, fatFindings, fatSwap, thresholdsFrom, type SwapCandidate } from '@/lib/nutrition/fat-checks';
import { rankSuggestions, type Suggestion } from '@/lib/agent/suggest';
import { parseOffProduct } from '@/lib/foods/off';
import { extrasFor, itemFromFood, per100Of } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';

const food = (id: string, name_ru: string, kcal: number, protein: number, fat: number, carbs: number, extra: Partial<Food> = {}): Food => ({
  id, user_id: null, source: 'seed', name_ru, state: 'as_is', kcal_100g: kcal, protein_100g: protein, fat_100g: fat, carbs_100g: carbs, confidence: 'high', ...extra,
});

describe('fat checks (D27)', () => {
  const base = { dayKcal: 1200, daySatfat: null, fatMax: 50, dayProgress: 0.5 };
  test('(a) one meal over 40% of the day ceiling', () => {
    expect(fatFindings({ ...base, mealFat: 25, dayFat: 25, dayProgress: 0.6 }).map((f) => f.kind)).toEqual(['meal_share']);
    expect(fatFindings({ ...base, mealFat: 15, dayFat: 20 })).toEqual([]);
  });
  test('(b) the day is over the ceiling, or will be at this pace', () => {
    expect(fatFindings({ ...base, mealFat: 10, dayFat: 55 }).map((f) => f.kind)).toEqual(['day_over']);
    expect(fatFindings({ ...base, mealFat: 10, dayFat: 32, dayProgress: 0.5 }).map((f) => f.kind)).toEqual(['day_pace']);
    // A breakfast alone does not project the whole day.
    expect(fatFindings({ ...base, mealFat: 10, dayFat: 18, dayProgress: 0.1 })).toEqual([]);
  });
  test('(c) saturated fat over 10% of calories, only when it is known', () => {
    expect(fatFindings({ ...base, mealFat: 5, dayFat: 20, daySatfat: 18 }).map((f) => f.kind)).toEqual(['satfat']);
    expect(fatFindings({ ...base, mealFat: 5, dayFat: 20, daySatfat: null })).toEqual([]);
  });
  test('thresholds come from settings with sane bounds', () => {
    expect(thresholdsFrom({ fat_thresholds: { meal_share: 0.5, max_per_day: 1 } })).toEqual({ mealShare: 0.5, satfatShare: 0.1, maxPerDay: 1 });
    expect(thresholdsFrom({ fat_thresholds: { meal_share: 7 } }).mealShare).toBe(0.4);
  });
  test('day progress runs from wake-up to sleep', () => {
    expect(dayProgress('08:00', '08:00', '23:00')).toBe(0);
    expect(dayProgress('15:30', '08:00', '23:00')).toBe(0.5);
    expect(dayProgress('01:00', '08:00', '23:00')).toBe(1);
  });
  test('swap: the fattiest item for a lean protein, no more calories, protein not lower', () => {
    const tvorog = food('t5', 'Творог 5%', 121, 17.2, 5, 1.8);
    const cands: SwapCandidate[] = [{ food: tvorog, step: 50, min: 100, max: 400 }];
    const swap = fatSwap([{ name: 'Арахис', grams: 30, kcal: 170, protein_g: 7.7, fat_g: 14.8 }, { name: 'Хлеб', grams: 50, kcal: 130, protein_g: 4, fat_g: 1 }], cands);
    expect(swap?.to).toEqual({ food_id: 't5', name: 'Творог 5%', grams: 100 });
    expect(swap?.text).toBe('вместо 30 г «Арахис» — 100 г «Творог 5%»: −49 ккал, +10 г белка, −10 г жиров');
  });
  test('no swap when nothing is fatty or nothing is better', () => {
    expect(fatSwap([{ name: 'Гречка', grams: 200, kcal: 220, protein_g: 8, fat_g: 2 }], [])).toBeNull();
  });
});

describe('saturated fat and sugar in meals', () => {
  test('known for USDA foods, unknown stays null', () => {
    const cheddar = food('c', 'Сыр чеддер', 403, 24.9, 33.1, 1.3, { satfat_100g: 18.87, sugar_100g: 0.48 });
    expect(extrasFor(50, per100Of(cheddar))).toEqual({ satfat_g: 9.4, sugar_g: 0.2 });
    expect(itemFromFood(food('x', 'X', 100, 1, 1, 1), 100, { source: 'agent' })).toMatchObject({ satfat_g: null, sugar_g: null });
  });
});

describe('«что съесть» ranking (D27)', () => {
  const opt = (title: string, kcal: number, protein_g: number, usual = false): Suggestion => ({
    title, items: [], kcal, protein_g, fat_g: 0, carbs_g: 0, protein_per_100kcal: Math.round((protein_g / kcal) * 1000) / 10, usual,
  });
  test('options within the calories left come first, then by protein per 100 kcal', () => {
    const r = rankSuggestions([opt('орехи', 300, 10), opt('творог', 200, 36), opt('грудка', 900, 170), opt('кефир', 200, 14)], 600);
    expect(r.map((o) => o.title)).toEqual(['творог', 'кефир', 'орехи', 'грудка']);
  });
  test('usual foods win a tie', () => {
    expect(rankSuggestions([opt('a', 100, 10), opt('b', 100, 10, true)], 600)[0].title).toBe('b');
  });
});

describe('Open Food Facts products', () => {
  test('consistent numbers are kept, per 100 ml for drinks', () => {
    const p = parseOffProduct({ code: '5449000000996', product_name: 'Coca-Cola Original', brands: 'Coca-Cola', categories_tags: ['en:beverages'], nutriments: { 'energy-kcal_100g': 44, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 10.9, sugars_100g: 10.9, 'saturated-fat_100g': 0 } });
    expect(p).toMatchObject({ name: 'Coca-Cola Original', brand: 'Coca-Cola', isDrink: true, url: 'https://world.openfoodfacts.org/product/5449000000996' });
    expect(p?.per100).toMatchObject({ kcal: 44, carbs: 10.9, sugar: 10.9 });
  });
  test('crowd-sourced nonsense is dropped (203 kcal with 11 g of sugar)', () => {
    expect(parseOffProduct({ code: '5000112669565', product_name: 'Fuse tea', nutriments: { 'energy-kcal_100g': 203, carbohydrates_100g: 11, sugars_100g: 11 } })).toBeNull();
    expect(parseOffProduct({ code: '1', product_name: 'X' })).toBeNull();
  });
});
