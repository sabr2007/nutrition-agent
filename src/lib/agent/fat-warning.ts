import 'server-only';
import { getDaySummary } from '@/lib/data/day';
import { todayFor } from '@/lib/data/profile';
import { localParts } from '@/lib/nutrition/day';
import { dayProgress, fatFindings, fatSwap, thresholdsFrom, type SwapItem } from '@/lib/nutrition/fat-checks';
import { overlayDay } from './dry-world';
import { loadCandidates } from './suggest';
import type { ToolCtx } from './tool-ctx';

export type FatWarning = { findings: string[]; swap: string | null; note_for_reply: string };

const NOTE = 'Скажи об этом одним коротким предложением и предложи эту замену в граммах. Без нотаций и без второго предупреждения.';

/** The code's verdict on fat after a meal (D27): null, or what to say and the swap to offer. */
export async function fatWarningFor(ctx: ToolCtx, meal: { id: string; day: string; fat_g: number; items: SwapItem[] }): Promise<FatWarning | null> {
  const profile = ctx.profile;
  if (meal.day !== todayFor(profile)) return null;
  const thr = thresholdsFrom(profile.settings);
  if (thr.maxPerDay <= 0) return null;
  const s = overlayDay(await getDaySummary(ctx.sb, ctx.userId, meal.day, profile), ctx.dry);
  const progress = dayProgress(localParts(new Date(), profile.timezone).hhmm, profile.quiet_end, profile.quiet_start);
  const findings = fatFindings({
    mealFat: meal.fat_g, dayFat: s.totals.fat_g, dayKcal: s.totals.kcal, daySatfat: s.totals.satfat_g,
    fatMax: s.goal?.fat_max_g ?? null, dayProgress: progress, thresholds: thr,
  });
  if (!findings.length) return null;
  const given = ctx.dry
    ? ctx.dry.nudges.filter((n) => n.kind === 'fat_warning').length
    : (await ctx.sb.from('nudges').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).eq('local_day', meal.day).eq('kind', 'fat_warning')).count ?? 0;
  if (given >= thr.maxPerDay) return null;
  const candidates = (await loadCandidates(ctx.sb)).map((c) => ({ food: c.food, step: c.rule.step, min: c.rule.min, max: c.rule.max }));
  const swap = fatSwap(meal.items, candidates);
  const detail = { findings: findings.map((f) => f.kind), swap: swap?.text ?? null };
  if (ctx.dry) ctx.dry.nudges.push({ kind: 'fat_warning', meal_id: meal.id });
  else await ctx.sb.from('nudges').insert({ user_id: ctx.userId, local_day: meal.day, kind: 'fat_warning', meal_id: meal.id, detail });
  return { findings: findings.map((f) => f.text), swap: swap?.text ?? null, note_for_reply: NOTE };
}
