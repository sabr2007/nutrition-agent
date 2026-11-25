// Deterministic fat checks after a meal is logged (D27): the code decides whether to warn, the
// agent only words it — one short warning with a concrete swap in grams, at most once per meal
// and three times a day.

import { macrosFor, per100Of, r1 } from './calc';
import type { Food } from './types';

export type FatThresholds = {
  /** One meal above this share of the day's fat ceiling. */
  mealShare: number;
  /** Saturated fat above this share of the day's calories. */
  satfatShare: number;
  /** Warnings per day at most. */
  maxPerDay: number;
};

export const DEFAULT_FAT_THRESHOLDS: FatThresholds = { mealShare: 0.4, satfatShare: 0.1, maxPerDay: 3 };

export type FatFindingKind = 'meal_share' | 'day_over' | 'day_pace' | 'satfat';
export type FatFinding = { kind: FatFindingKind; text: string };

export type FatCheckInput = {
  mealFat: number;
  dayFat: number;
  dayKcal: number;
  /** Known saturated fat of the day (meals without data are left out), or null. */
  daySatfat: number | null;
  fatMax: number | null;
  /** Share of the waking day already passed, 0..1. */
  dayProgress: number;
  thresholds?: Partial<FatThresholds>;
};

/** Pace projection starts only after a third of the day: a breakfast alone says little. */
const PACE_FROM = 0.33;
const PACE_UNTIL = 0.9;
const PACE_SLACK = 1.15;
const MIN_KCAL_FOR_SATFAT = 400;

export function thresholdsFrom(settings: Record<string, unknown> | null | undefined): FatThresholds {
  const t = (settings?.fat_thresholds ?? {}) as Partial<Record<'meal_share' | 'satfat_share' | 'max_per_day', unknown>>;
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && v >= lo && v <= hi ? v : def);
  return {
    mealShare: num(t.meal_share, 0.1, 1, DEFAULT_FAT_THRESHOLDS.mealShare),
    satfatShare: num(t.satfat_share, 0.05, 0.3, DEFAULT_FAT_THRESHOLDS.satfatShare),
    maxPerDay: num(t.max_per_day, 0, 10, DEFAULT_FAT_THRESHOLDS.maxPerDay),
  };
}

export function fatFindings(i: FatCheckInput): FatFinding[] {
  const t = { ...DEFAULT_FAT_THRESHOLDS, ...i.thresholds };
  const out: FatFinding[] = [];
  if (i.fatMax) {
    if (i.mealFat > t.mealShare * i.fatMax) {
      out.push({ kind: 'meal_share', text: `в этом приёме ${Math.round(i.mealFat)} г жиров — больше ${Math.round(t.mealShare * 100)}% дневного потолка (${i.fatMax} г)` });
    }
    if (i.dayFat > i.fatMax) {
      out.push({ kind: 'day_over', text: `за день уже ${Math.round(i.dayFat)} г жиров при потолке ${i.fatMax} г` });
    } else if (i.dayProgress >= PACE_FROM && i.dayProgress <= PACE_UNTIL && i.dayFat / i.dayProgress > i.fatMax * PACE_SLACK) {
      out.push({ kind: 'day_pace', text: `в таком темпе к вечеру выйдет около ${Math.round(i.dayFat / i.dayProgress)} г жиров при потолке ${i.fatMax} г` });
    }
  }
  if (i.daySatfat != null && i.dayKcal >= MIN_KCAL_FOR_SATFAT && (i.daySatfat * 9) / i.dayKcal > t.satfatShare) {
    out.push({ kind: 'satfat', text: `насыщенные жиры — ${Math.round(((i.daySatfat * 9) / i.dayKcal) * 100)}% калорий дня (ориентир до ${Math.round(t.satfatShare * 100)}%)` });
  }
  return out;
}

/** Share of the waking day passed: from the end of quiet hours (wake) to their start (sleep). */
export function dayProgress(nowHHMM: string, wakeHHMM: string, sleepHHMM: string): number {
  const m = (s: string) => { const [h, mm] = s.split(':').map(Number); return h * 60 + (mm || 0); };
  const wake = m(wakeHHMM);
  let sleep = m(sleepHHMM);
  let now = m(nowHHMM);
  if (sleep <= wake) sleep += 1440;
  if (now < wake) now += 1440;
  return Math.max(0, Math.min(1, (now - wake) / (sleep - wake)));
}

export type SwapItem = { name: string; grams: number; kcal: number; protein_g: number; fat_g: number };
export type SwapCandidate = { food: Food; step: number; min: number; max: number };
export type Swap = { from: SwapItem; to: { food_id: string; name: string; grams: number }; dKcal: number; dProtein: number; dFat: number; text: string };

const signed = (n: number, unit: string) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n))} ${unit}`;

/**
 * A leaner swap for the fattiest item: a candidate in a realistic portion with no more
 * calories, most fat removed, protein not lower. Null when nothing is clearly better.
 */
export function fatSwap(items: SwapItem[], candidates: SwapCandidate[]): Swap | null {
  const from = [...items].filter((i) => i.fat_g >= 5).sort((a, b) => b.fat_g - a.fat_g)[0];
  if (!from) return null;
  let best: Swap | null = null;
  for (const c of candidates) {
    const p = per100Of(c.food);
    if (p.partial || p.kcal <= 0 || c.food.name_ru === from.name) continue;
    for (let g = c.min; g <= c.max; g += c.step) {
      const m = macrosFor(g, p);
      if (m.kcal > from.kcal * 1.05) break;
      const dFat = m.fat_g - from.fat_g;
      const dProtein = m.protein_g - from.protein_g;
      if (dFat > -3 || dProtein < 0) continue;
      const better = !best || dFat < best.dFat - 0.5 || (Math.abs(dFat - best.dFat) <= 0.5 && dProtein > best.dProtein);
      if (better) {
        const dKcal = m.kcal - from.kcal;
        best = {
          from, to: { food_id: c.food.id, name: c.food.name_ru, grams: g }, dKcal: r1(dKcal), dProtein: r1(dProtein), dFat: r1(dFat),
          text: `вместо ${Math.round(from.grams)} г «${from.name}» — ${g} г «${c.food.name_ru}»: ${signed(dKcal, 'ккал')}, ${signed(dProtein, 'г белка')}, ${signed(dFat, 'г жиров')}`,
        };
      }
    }
  }
  return best;
}
