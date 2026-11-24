import { describe, expect, it } from 'vitest';
import { normalizeLabel, type LabelOutput, type LabelNutrients } from '@/lib/recognition/label';
import { checkLabelNumbers, kcalFromMacros } from '@/lib/nutrition/label-math';

const nutrients = (n: Partial<LabelNutrients>): LabelNutrients => ({ kcal: null, kj: null, protein: null, fat: null, carbs: null, fiber: null, ...n });

const label = (o: Partial<LabelOutput>): LabelOutput => ({
  is_label: true, name: 'Каша овсяная', brand: null, per100: nutrients({}), per100_unit: 'g', per_serving: nutrients({}),
  serving_g: null, package_g: null, prepared: false, confidence: 0.9, state: 'dry', ...o,
});

const codes = (l: ReturnType<typeof normalizeLabel>) => l.warnings.map((w) => w.code);

describe('normalizeLabel', () => {
  it('keeps per-100 g values as printed when they are consistent', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kcal: 355, protein: 11.9, fat: 7.2, carbs: 60.5 }), package_g: 400 }));
    expect(l.per100).toEqual({ kcal: 355, protein: 11.9, fat: 7.2, carbs: 60.5, fiber: null });
    expect(l.state).toBe('dry');
    expect(l.packageG).toBe(400);
    expect(l.warnings).toEqual([]);
  });

  it('scales per-serving values to 100 g', () => {
    const l = normalizeLabel(label({ per_serving: nutrients({ kcal: 142, protein: 4.8, fat: 2.9, carbs: 24.2 }), serving_g: 40 }));
    expect(l.per100.kcal).toBe(355);
    expect(l.per100.protein).toBe(12);
    expect(l.per100.carbs).toBe(60.5);
    expect(l.servingG).toBe(40);
    expect(codes(l)).toContain('per_serving');
  });

  it('refuses per-serving values without the serving mass', () => {
    expect(() => normalizeLabel(label({ per_serving: nutrients({ kcal: 142, protein: 4.8, fat: 2.9, carbs: 24.2 }) }))).toThrow(/массы/);
  });

  it('converts kJ to kcal when kcal is missing', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kj: 1486, protein: 11.9, fat: 7.2, carbs: 60.5 }) }));
    expect(l.per100.kcal).toBeCloseTo(355.2, 1);
    expect(codes(l)).toContain('kj');
  });

  it('computes kcal from macros when no energy value is readable', () => {
    const l = normalizeLabel(label({ per100: nutrients({ protein: 10, fat: 5, carbs: 60 }) }));
    expect(l.per100.kcal).toBe(325);
    expect(codes(l)).toContain('kcal_from_macros');
  });

  it('flags kcal that disagree with the macros', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kcal: 120, protein: 12, fat: 7, carbs: 60 }) }));
    expect(codes(l)).toContain('mismatch');
    expect(l.kcalFromMacros).toBe(351);
  });

  it('flags a misread decimal (11,9 read as 119)', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kcal: 355, protein: 119, fat: 7.2, carbs: 60.5 }) }));
    expect(l.per100.protein).toBe(100);
    expect(codes(l)).toContain('macro_sum');
  });

  it('reports missing macros instead of inventing them', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kcal: 250, protein: 8 }) }));
    expect(l.per100.fat).toBe(0);
    expect(codes(l)).toContain('missing');
    expect(codes(l)).not.toContain('mismatch');
  });

  it('marks values for the prepared product as cooked', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kcal: 88, protein: 3, fat: 1.5, carbs: 15.5 }), prepared: true }));
    expect(l.state).toBe('cooked');
    expect(codes(l)).toContain('prepared');
  });

  it('explains when the photo is not a label at all', () => {
    expect(() => normalizeLabel(label({ is_label: false }))).toThrow(/пищевую ценность/);
  });

  it('notes per-100 ml values', () => {
    const l = normalizeLabel(label({ per100: nutrients({ kcal: 52, protein: 3, fat: 2.5, carbs: 4.7 }), per100_unit: 'ml', state: 'as_is' }));
    expect(l.unit).toBe('ml');
    expect(codes(l)).toContain('per_ml');
  });
});

describe('label math', () => {
  it('uses Atwater factors', () => {
    expect(kcalFromMacros(11.9, 7.2, 60.5)).toBe(354.4);
  });

  it('skips the relative check for near-zero energy', () => {
    expect(checkLabelNumbers(2, 0.1, 0, 0.3).kcalMismatch).toBe(false);
  });

  it('detects an impossible macro sum', () => {
    expect(checkLabelNumbers(400, 60, 30, 20).macroSumTooHigh).toBe(true);
  });
});
