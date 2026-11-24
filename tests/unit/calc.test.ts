import { describe, expect, test } from 'vitest';
import { convertWeight, gramsForPortion, itemFromFood, macrosFor, sumMacros, withGrams, kcalRange } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';

const chickenRaw: Food = {
  id: 'f1', user_id: null, source: 'usda_sr', name_ru: 'Куриная грудка (филе), сырая', state: 'raw',
  kcal_100g: 120, protein_100g: 22.5, fat_100g: 2.62, carbs_100g: 0, confidence: 'high',
};

describe('macrosFor', () => {
  test('scales per-100 g values linearly and rounds to 0.1', () => {
    expect(macrosFor(250, { kcal: 120, protein: 22.5, fat: 2.62, carbs: 0 })).toEqual({ kcal: 300, protein_g: 56.3, fat_g: 6.6, carbs_g: 0 });
  });
  test('zero grams gives zero macros', () => {
    expect(macrosFor(0, { kcal: 884, protein: 0, fat: 100, carbs: 0 }).kcal).toBe(0);
  });
  test('rejects negative grams', () => {
    expect(() => macrosFor(-1, { kcal: 1, protein: 0, fat: 0, carbs: 0 })).toThrow();
  });
});

describe('typical day from the plan', () => {
  test('breakfast: 3 eggs (156 g) + 40 g oats ≈ 375 kcal', () => {
    const eggs = macrosFor(156, { kcal: 143, protein: 12.56, fat: 9.51, carbs: 0.72 });
    const oats = macrosFor(40, { kcal: 379, protein: 13.15, fat: 6.52, carbs: 67.7 });
    const total = sumMacros([eggs, oats]);
    expect(total.kcal).toBeCloseTo(374.7, 0);
    expect(total.protein_g).toBeCloseTo(24.9, 0);
  });
});

describe('convertWeight (raw ↔ cooked)', () => {
  test('150 g cooked chicken with yield 0.75 = 200 g raw', () => {
    expect(convertWeight(150, 'cooked', 'raw', 0.75)).toBe(200);
  });
  test('50 g dry buckwheat with yield 2.4 = 120 g cooked', () => {
    expect(convertWeight(50, 'dry', 'cooked', 2.4)).toBe(120);
  });
  test('no yield factor => unchanged', () => {
    expect(convertWeight(100, 'cooked', 'raw', null)).toBe(100);
  });
  test('same state => unchanged', () => {
    expect(convertWeight(100, 'raw', 'raw', 0.75)).toBe(100);
  });
});

describe('items', () => {
  test('itemFromFood snapshots per-100 values and computes macros', () => {
    const it = itemFromFood(chickenRaw, 200, { source: 'template' });
    expect(it.kcal).toBe(240);
    expect(it.protein_g).toBe(45);
    expect(it.per100).toEqual({ kcal: 120, protein: 22.5, fat: 2.62, carbs: 0 });
  });
  test('withGrams recomputes macros and marks edited', () => {
    const it = withGrams(itemFromFood(chickenRaw, 200, { source: 'model', model_grams: 200 }), 250);
    expect(it.kcal).toBe(300);
    expect(it.edited).toBe(true);
    expect(it.model_grams).toBe(200);
  });
  test('kcal range for composite dishes', () => {
    expect(kcalRange(350, { kcal_low_100g: 170, kcal_high_100g: 280 })).toEqual([595, 980]);
    expect(kcalRange(100, { kcal_low_100g: null, kcal_high_100g: null })).toBeNull();
  });
  test('gramsForPortion uses first portion by default', () => {
    expect(gramsForPortion({ portions: [{ label: '1 шт (С1)', g: 52 }], default_portion_g: 52 }, 3)).toBe(156);
    expect(gramsForPortion({ portions: [], default_portion_g: 30 }, 2)).toBe(60);
  });
});
