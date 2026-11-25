// Foods named by the person (save_user_food, D24): their numbers for an amount → per 100 g.
// The numbers come only from the person (or a label / a web page with its URL); this code
// converts and checks them, like normalizeLabel does for label photos.
import { checkLabelNumbers, MACRO_SUM_LIMIT } from './label-math';

export type FoodUnit = 'g' | 'ml' | 'piece' | 'pack';

export type UserFoodInput = {
  name: string;
  brand?: string | null;
  kcal: number;
  protein?: number | null;
  fat?: number | null;
  carbs?: number | null;
  /** How much the numbers refer to: 500 (ml) for «0,5 л — 170 ккал». */
  amount: number;
  unit: FoodUnit;
  /** Weight of one piece/pack in grams, when known. */
  unit_grams?: number | null;
};

export type Per100Nullable = { kcal: number; protein: number | null; fat: number | null; carbs: number | null };

export type UserFoodNumbers = {
  per100: Per100Nullable;
  /** One usual portion: the stated amount (g/ml) or one piece/pack. */
  portion: { label: string; g: number };
  confidence: 'high' | 'user_kcal_only';
  /** A piece/pack of unknown weight is counted as 100 g. */
  nominalWeight: boolean;
  note: string;
};

export type UserFoodErrorCode = 'kcal_mismatch' | 'macro_sum' | 'too_dense' | 'invalid';

export class UserFoodError extends Error {
  constructor(public code: UserFoodErrorCode, message: string, public detail: Record<string, number> = {}) {
    super(message);
    this.name = 'UserFoodError';
  }
}

/** A piece or pack whose weight nobody stated is counted as 100 g (honest and visible in the note). */
export const NOMINAL_UNIT_G = 100;
/** Pure fat is ~900 kcal/100 g: more means the amount is wrong. */
const MAX_KCAL_100G = 900;

const r1 = (n: number) => Math.round(n * 10) / 10;
const known = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (n: number) => String(r1(n)).replace('.', ',');

export function amountLabel(amount: number, unit: FoodUnit): string {
  if (unit === 'ml') return amount >= 500 ? `${num(amount / 1000)} л` : `${num(amount)} мл`;
  if (unit === 'piece') return `${num(amount)} шт`;
  if (unit === 'pack') return `${num(amount)} уп.`;
  return `${num(amount)} г`;
}

/** Converts stated numbers to per-100 g values (1 ml = 1 g when the density is unknown). */
export function userFoodNumbers(i: UserFoodInput, opts: { allowMismatch?: boolean } = {}): UserFoodNumbers {
  if (!(i.amount > 0) || !(i.kcal >= 0)) throw new UserFoodError('invalid', 'Нужны калории и количество, к которому они относятся');
  const perUnit = i.unit === 'piece' || i.unit === 'pack';
  const nominalWeight = perUnit && !known(i.unit_grams);
  const unitG = perUnit ? (known(i.unit_grams) ? i.unit_grams : NOMINAL_UNIT_G) : 1;
  const grams = i.amount * unitG;
  const k = 100 / grams;
  const per100: Per100Nullable = {
    kcal: r1(i.kcal * k),
    protein: known(i.protein) ? r1(i.protein * k) : null,
    fat: known(i.fat) ? r1(i.fat * k) : null,
    carbs: known(i.carbs) ? r1(i.carbs * k) : null,
  };
  const allMacros = per100.protein != null && per100.fat != null && per100.carbs != null;
  if (!nominalWeight) {
    if (per100.kcal > MAX_KCAL_100G) {
      throw new UserFoodError('too_dense', `${num(i.kcal)} ккал на ${amountLabel(i.amount, i.unit)} — больше 900 ккал на 100 г: проверь количество`, { kcal_100g: per100.kcal });
    }
    const sum = (per100.protein ?? 0) + (per100.fat ?? 0) + (per100.carbs ?? 0);
    if (sum > MACRO_SUM_LIMIT) throw new UserFoodError('macro_sum', 'Белков, жиров и углеводов выходит больше 100 г на 100 г: проверь цифры', { macro_sum_100g: r1(sum) });
  }
  if (allMacros && !opts.allowMismatch) {
    const check = checkLabelNumbers(per100.kcal, per100.protein!, per100.fat!, per100.carbs!);
    if (check.kcalMismatch) {
      throw new UserFoodError('kcal_mismatch', `Калории не сходятся с БЖУ: по белкам, жирам и углеводам выходит ~${Math.round(check.kcalFromMacros / k)} ккал, а названо ${num(i.kcal)}`, {
        kcal_stated: i.kcal, kcal_from_macros: r1(check.kcalFromMacros / k),
      });
    }
  }
  const one = perUnit ? { label: `1 ${i.unit === 'piece' ? 'шт' : 'уп.'}`, g: unitG } : { label: amountLabel(i.amount, i.unit), g: grams };
  const noteParts = [`${num(i.kcal)} ккал на ${amountLabel(i.amount, i.unit)}`];
  if (i.unit === 'ml') noteParts.push('пересчёт на 100 мл, 1 мл ≈ 1 г');
  if (nominalWeight) noteParts.push(`вес 1 ${i.unit === 'piece' ? 'шт' : 'уп.'} неизвестен — считается как ${NOMINAL_UNIT_G} г`);
  if (!allMacros) noteParts.push('БЖУ неизвестны');
  return { per100, portion: one, confidence: allMacros ? 'high' : 'user_kcal_only', nominalWeight, note: noteParts.join('; ') };
}

/** Name without amounts and calories: «Fuse Tea 0,5 л (170 ккал)» → «Fuse Tea». Keeps «Творог 5%». */
export function cleanFoodName(name: string): string {
  return name
    .replace(/\(([^)]*\d[^)]*)\)/g, ' ')
    .replace(/[-–—,:]?\s*\d+([.,]\d+)?\s*(ккал|кал|kcal|калори\w*|грамм\w*|гр|г|мл|ml|литр\w*|л|шт\w*|уп\w*)(?=$|[\s,.;)])\.?/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.;:–—-]+$/g, '')
    .trim();
}

/** Identity of a personal food: name + brand, case- and ё-insensitive. */
export function foodKey(name: string, brand?: string | null): string {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  return `${norm(name)}|${norm(brand ?? '')}`;
}

/** Stored numbers equal the new ones (rounding aside): reuse the row instead of a new version. */
export function sameNumbers(a: Per100Nullable, b: Per100Nullable): boolean {
  const close = (x: number | null, y: number | null, tol: number) => (x == null || y == null ? x === y : Math.abs(x - y) <= tol);
  return close(a.kcal, b.kcal, 0.6) && close(a.protein, b.protein, 0.15) && close(a.fat, b.fat, 0.15) && close(a.carbs, b.carbs, 0.15);
}
