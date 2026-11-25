import { describe, expect, test } from 'vitest';
import { cleanFoodName, foodKey, sameNumbers, UserFoodError, userFoodNumbers } from '@/lib/nutrition/user-food';
import { userFoodRow } from '@/lib/data/foods';
import { per100Of } from '@/lib/nutrition/calc';
import { totalsOf, type DayMeal } from '@/lib/data/day';

describe('userFoodNumbers (save_user_food)', () => {
  test('drink in ml: 170 kcal per 0,5 l → 34 kcal per 100 ml (1 ml = 1 g), kcal only', () => {
    const n = userFoodNumbers({ name: 'Fuse Tea', kcal: 170, amount: 500, unit: 'ml' });
    expect(n.per100).toEqual({ kcal: 34, protein: null, fat: null, carbs: null });
    expect(n.confidence).toBe('user_kcal_only');
    expect(n.portion).toEqual({ label: '0,5 л', g: 500 });
    expect(n.note).toMatch(/1 мл ≈ 1 г/);
    expect(n.note).toMatch(/БЖУ неизвестны/);
  });
  test('all macros known and consistent → high confidence', () => {
    const n = userFoodNumbers({ name: 'Батончик', kcal: 125, protein: 5, fat: 5, carbs: 15, amount: 50, unit: 'g' });
    expect(n.per100).toEqual({ kcal: 250, protein: 10, fat: 10, carbs: 30 });
    expect(n.confidence).toBe('high');
  });
  test('calories that do not match the macros are rejected unless confirmed', () => {
    expect(() => userFoodNumbers({ name: 'X', kcal: 100, protein: 20, fat: 20, carbs: 20, amount: 100, unit: 'g' })).toThrow(UserFoodError);
    expect(userFoodNumbers({ name: 'X', kcal: 100, protein: 20, fat: 20, carbs: 20, amount: 100, unit: 'g' }, { allowMismatch: true }).per100.kcal).toBe(100);
  });
  test('a piece of unknown weight counts as 100 g, honestly noted', () => {
    const n = userFoodNumbers({ name: 'Батончик', kcal: 230, amount: 1, unit: 'piece' });
    expect(n.per100.kcal).toBe(230);
    expect(n.nominalWeight).toBe(true);
    expect(n.portion).toEqual({ label: '1 шт', g: 100 });
    expect(n.note).toMatch(/вес 1 шт неизвестен/);
  });
  test('a piece of known weight', () => {
    const n = userFoodNumbers({ name: 'Батончик', kcal: 230, amount: 2, unit: 'piece', unit_grams: 25 });
    expect(n.per100.kcal).toBe(460);
    expect(n.portion).toEqual({ label: '1 шт', g: 25 });
  });
  test('impossible numbers', () => {
    expect(() => userFoodNumbers({ name: 'X', kcal: 1000, amount: 100, unit: 'g' })).toThrow(/900/);
    expect(() => userFoodNumbers({ name: 'X', kcal: 400, protein: 50, fat: 10, carbs: 50, amount: 100, unit: 'g', }, { allowMismatch: true })).toThrow(/больше 100 г/);
    expect(() => userFoodNumbers({ name: 'X', kcal: 100, amount: 0, unit: 'g' })).toThrow(UserFoodError);
  });
});

describe('cleanFoodName', () => {
  test('drops amounts and calories, keeps fat percentage', () => {
    expect(cleanFoodName('Fuse Tea 0,5 л (170 ккал)')).toBe('Fuse Tea');
    expect(cleanFoodName('Батончик Lumo, 50 г')).toBe('Батончик Lumo');
    expect(cleanFoodName('Творог 5%')).toBe('Творог 5%');
    expect(cleanFoodName('гречка')).toBe('гречка');
  });
});

describe('dedup by name + brand', () => {
  test('key ignores case, ё and spaces', () => {
    expect(foodKey('Fuse  Tea', 'Fuse Tea')).toBe(foodKey('fuse tea', 'FUSE TEA'));
    expect(foodKey('Творог', null)).not.toBe(foodKey('Творог', 'Простоквашино'));
    expect(foodKey('Ёжик', '')).toBe(foodKey('ежик', null));
  });
  test('same numbers reuse the row, new numbers make a new version', () => {
    expect(sameNumbers({ kcal: 34, protein: null, fat: null, carbs: null }, { kcal: 34.2, protein: null, fat: null, carbs: null })).toBe(true);
    expect(sameNumbers({ kcal: 34, protein: null, fat: null, carbs: null }, { kcal: 50, protein: null, fat: null, carbs: null })).toBe(false);
    expect(sameNumbers({ kcal: 34, protein: null, fat: null, carbs: null }, { kcal: 34, protein: 0, fat: 0, carbs: 8.5 })).toBe(false);
  });
});

describe('userFoodRow', () => {
  test('a drink from the person: clean name, drinks category, nullable macros', () => {
    const input = { name: 'Fuse Tea 0,5 л', brand: 'Fuse Tea', kcal: 170, amount: 500, unit: 'ml' as const, origin: 'user' as const };
    const row = userFoodRow('u1', input, userFoodNumbers(input));
    expect(row).toMatchObject({ user_id: 'u1', source: 'user', name_ru: 'Fuse Tea', brand: 'Fuse Tea', category: 'drinks', kcal_100g: 34, protein_100g: null, confidence: 'user_kcal_only', default_portion_g: 500 });
    expect(row.notes).toMatch(/^Со слов пользователя/);
  });
});

describe('unknown macros in day totals', () => {
  test('per100 of a kcal-only food is partial; totals count such items', () => {
    const p = per100Of({ kcal_100g: 34, protein_100g: null, fat_100g: null, carbs_100g: null });
    expect(p).toEqual({ kcal: 34, protein: 0, fat: 0, carbs: 0, partial: true });
    const meal = (partial: boolean): DayMeal => ({
      id: 'm', root_id: 'm', eaten_at: '2026-11-26T08:00:00Z', logged_at: '2026-11-26T08:00:00Z', slot: 'snack', title: 't', input_method: 'agent',
      template_id: null, confidence: null, kcal: 170, protein_g: 0, fat_g: 0, carbs_g: 0, note: null, is_labeled: false,
      items: [{ id: 'i', food_id: 'f', name: 'x', grams: 500, kcal: 170, protein_g: 0, fat_g: 0, carbs_g: 0, confidence: null, source: 'agent', partial }],
    });
    expect(totalsOf([meal(true), meal(false)])).toMatchObject({ kcal: 340, meals_count: 2, macros_incomplete: 1 });
  });
});
