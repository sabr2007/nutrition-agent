import type { Food } from '@/lib/nutrition/types';
import type { RecognizedItem } from './schema';
import { normalizeQuery } from './match';

export type RunItem = RecognizedItem & { run: number; food: Food | null; quality: number };

export type Cluster = { key: string; items: RunItem[] };

/** Groups the same food across self-consistency runs (by matched food, else by query). */
/** The same food listed twice in one run (e.g. pineapple on pizza + side) is merged. */
export function mergeWithinRun(run: RunItem[]): RunItem[] {
  const out: RunItem[] = [];
  for (const it of run) {
    const key = it.food?.id ?? `q:${normalizeQuery(it.food_query)}`;
    const prev = out.find((x) => (x.food?.id ?? `q:${normalizeQuery(x.food_query)}`) === key);
    if (prev) {
      prev.grams += it.grams;
      prev.grams_low += it.grams_low;
      prev.grams_high += it.grams_high;
      prev.confidence = Math.min(prev.confidence, it.confidence);
    } else out.push({ ...it });
  }
  return out;
}

export function clusterRuns(runsIn: RunItem[][]): Cluster[] {
  const runs = runsIn.map(mergeWithinRun);
  const clusters: Cluster[] = [];
  for (const run of runs) {
    for (const it of run) {
      const key = it.food?.id ?? `q:${normalizeQuery(it.food_query)}`;
      const existing = clusters.find((c) => c.key === key && !c.items.some((x) => x.run === it.run));
      if (existing) existing.items.push(it);
      else clusters.push({ key, items: [it] });
    }
  }
  return clusters;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type ClusterSummary = {
  key: string;
  representative: RunItem;
  food: Food | null;
  grams: number;
  gramsLow: number;
  gramsHigh: number;
  presence: number; // share of runs that saw this item
  spread: number; // (max-min)/mean of grams across runs
  confidence: number;
};

export function summarize(c: Cluster, nRuns: number): ClusterSummary {
  const grams = c.items.map((i) => i.grams);
  const g = median(grams);
  const mean = grams.reduce((a, b) => a + b, 0) / grams.length;
  const spread = grams.length > 1 && mean > 0 ? (Math.max(...grams) - Math.min(...grams)) / mean : 0;
  const presence = c.items.length / Math.max(1, nRuns);
  const modelConf = c.items.reduce((a, i) => a + i.confidence, 0) / c.items.length;
  const quality = Math.max(...c.items.map((i) => i.quality));
  // Disagreement between runs lowers confidence; so does a weak database match.
  const confidence = Math.max(0.05, Math.min(1, modelConf * (0.5 + 0.5 * presence) * (1 - Math.min(spread, 0.6)) * quality));
  const rep = c.items.reduce((best, i) => (i.confidence > best.confidence ? i : best), c.items[0]);
  return {
    key: c.key,
    representative: rep,
    food: rep.food,
    grams: Math.round(g),
    gramsLow: Math.round(Math.min(...c.items.map((i) => i.grams_low))),
    gramsHigh: Math.round(Math.max(...c.items.map((i) => i.grams_high))),
    presence,
    spread,
    confidence: Number(confidence.toFixed(3)),
  };
}

/** Personal calibration: median ratio user/model for a food, shrunk toward 1. */
export function calibrationRatio(ratios: number[], prior = 3): number {
  const clean = ratios.filter((r) => Number.isFinite(r) && r > 0.2 && r < 5);
  if (!clean.length) return 1;
  const m = median(clean);
  const n = clean.length;
  return Number((1 + (m - 1) * (n / (n + prior))).toFixed(3));
}
