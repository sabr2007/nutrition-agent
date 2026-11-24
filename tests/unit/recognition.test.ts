import { describe, expect, test } from 'vitest';
import { quickParse } from '@/lib/recognition/quickparse';
import { calibrationRatio, clusterRuns, overallAgreement, summarize, type RunItem } from '@/lib/recognition/aggregate';
import { pickBest } from '@/lib/recognition/match';
import type { Food } from '@/lib/nutrition/types';

const food = (id: string, state: Food['state'], score: number, kcal = 120): Food => ({
  id, user_id: null, source: 't', name_ru: id, state, kcal_100g: kcal, protein_100g: 20, fat_100g: 2, carbs_100g: 0, confidence: 'high', score,
});
const ri = (run: number, f: Food | null, grams: number, conf = 0.8, q = 'x'): RunItem => ({
  run, food: f, quality: 1, label_ru: q, food_query: q, state: 'cooked', cooking_method: null, grams,
  grams_low: grams * 0.8, grams_high: grams * 1.2, count: null, visible_fat: null, confidence: conf,
});

describe('quickParse', () => {
  test('food + grams', () => {
    expect(quickParse('грудка 250')).toEqual([{ query: 'грудка', grams: 250, count: null, state: null }]);
  });
  test('count + food', () => {
    expect(quickParse('3 яйца')).toEqual([{ query: 'яйца', grams: null, count: 3, state: null }]);
  });
  test('multiple segments with units and states', () => {
    expect(quickParse('гречка 50 г сухая, творог 200г и банан')).toEqual([
      { query: 'гречка сухая', grams: 50, count: null, state: 'dry' },
      { query: 'творог', grams: 200, count: null, state: null },
      { query: 'банан', grams: null, count: null, state: null },
    ]);
  });
  test('number words', () => {
    expect(quickParse('два банана')?.[0]).toMatchObject({ query: 'банана', count: 2 });
  });
  test('long sentences go to the LLM', () => {
    expect(quickParse('на обеде у друзей съел тарелку плова и немного салата с майонезом')).toBeNull();
  });
});

describe('self-consistency aggregation', () => {
  const chicken = food('chicken', 'cooked', 2);
  const rice = food('rice', 'cooked', 2, 130);
  test('clusters the same food across runs and takes the median', () => {
    const clusters = clusterRuns([[ri(0, chicken, 180), ri(0, rice, 150)], [ri(1, chicken, 220)]]);
    expect(clusters).toHaveLength(2);
    const s = summarize(clusters[0], 2);
    expect(s.grams).toBe(200);
    expect(s.presence).toBe(1);
    expect(s.spread).toBeCloseTo(0.2, 2);
    const r = summarize(clusters[1], 2);
    expect(r.presence).toBe(0.5);
    expect(r.confidence).toBeLessThan(s.confidence);
  });
  test('agreement is 1 for identical runs and lower when runs disagree', () => {
    const same = clusterRuns([[ri(0, chicken, 200)], [ri(1, chicken, 200)]]).map((c) => summarize(c, 2));
    expect(overallAgreement(same)).toBe(1);
    const diff = clusterRuns([[ri(0, chicken, 100)], [ri(1, chicken, 300)]]).map((c) => summarize(c, 2));
    expect(overallAgreement(diff)).toBeLessThan(0.1);
  });
  test('calibration ratio shrinks toward 1 with few corrections', () => {
    expect(calibrationRatio([])).toBe(1);
    expect(calibrationRatio([1.4])).toBeCloseTo(1.1, 2);
    expect(calibrationRatio([1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4])).toBeCloseTo(1.3, 2);
  });
});

describe('pickBest', () => {
  test('prefers the recognized state when scores are close', () => {
    const res = [food('raw', 'raw', 1.7), food('cooked', 'cooked', 1.6)];
    expect(pickBest(res, 'cooked')?.food.id).toBe('cooked');
    expect(pickBest(res, 'raw')?.food.id).toBe('raw');
  });
  test('falls back to top result when the same-state match is weak', () => {
    const res = [food('raw', 'raw', 2.0), food('cooked', 'cooked', 0.6)];
    expect(pickBest(res, 'cooked')?.food.id).toBe('raw');
  });
  test('empty results → null', () => {
    expect(pickBest([], 'raw')).toBeNull();
  });
});

describe('plausibility guard', () => {
  test('olives never match olive oil', async () => {
    const { pickBest } = await import('@/lib/recognition/match');
    const oil = { ...food('oil', 'as_is', 1.5, 884), fat_100g: 100, category: 'fats' };
    const olives = { ...food('olives', 'as_is', 1.0, 145), fat_100g: 15 };
    expect(pickBest([oil, olives], null, undefined, 'оливки')?.food.id).toBe('olives');
    expect(pickBest([oil], null, undefined, 'оливки')).toBeNull();
    expect(pickBest([oil], null, undefined, 'масло оливковое')?.food.id).toBe('oil');
  });
});

describe('within-run merge', () => {
  test('same food twice in one run is summed', async () => {
    const { mergeWithinRun } = await import('@/lib/recognition/aggregate');
    const pine = food('pine', 'raw', 2, 50);
    const merged = mergeWithinRun([ri(0, pine, 300), ri(0, pine, 80)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].grams).toBe(380);
  });
  test('sauce guard: salad caesar never matches a dressing', async () => {
    const { pickBest } = await import('@/lib/recognition/match');
    const dressing = { ...food('dressing', 'as_is', 2, 400), category: 'sauces' };
    const salad = food('salad', 'as_is', 1.8, 200);
    expect(pickBest([dressing, salad], null, undefined, 'салат цезарь')?.food.id).toBe('salad');
    expect(pickBest([dressing], null, undefined, 'заправка цезарь')?.food.id).toBe('dressing');
  });
});

describe('intent hints', () => {
  test('food reports vs questions', async () => {
    const { isFoodReport, matchSkill } = await import('@/lib/agent/skills-router');
    expect(isFoodReport('съел тарелку плова у друзей')).toBe(true);
    expect(isFoodReport('на обед был борщ и котлета')).toBe(true);
    expect(isFoodReport('выпил протеин после зала')).toBe(true);
    expect(isFoodReport('что съесть сейчас?')).toBe(false);
    expect(matchSkill('я сорвался и съел бургер')).toBe('slip_review');
    expect(matchSkill('что мне съесть, чтобы добрать белок')).toBe('whats_to_eat_now');
    expect(matchSkill('давай закроем день')).toBe('close_day');
  });
});
