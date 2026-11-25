import 'server-only';
import { openai } from '@ai-sdk/openai';
import { isStepCount, streamText } from 'ai';
import { z } from 'zod';
import { callModel } from '@/lib/llm/router';
import { planOptions } from '@/lib/llm/models';
import { checkLabelNumbers } from '@/lib/nutrition/label-math';

// Nutrition facts of a packaged product from the web (D26): the plan's built-in web_search finds
// a page, the model copies the printed numbers and the page URL as JSON, and the code checks
// them (Atwater, ≤ 900 kcal/100 g, the URL is one of the pages actually searched).

export type WebFood = {
  name: string; brand: string | null; basis: '100g' | '100ml'; url: string;
  per100: { kcal: number; protein: number | null; fat: number | null; carbs: number | null; satfat: number | null; sugar: number | null };
};

const Answer = z.object({
  found: z.boolean(),
  name: z.string().max(160).optional(),
  brand: z.string().max(80).nullish(),
  basis: z.enum(['100g', '100ml']).optional(),
  kcal: z.number().min(0).max(900).optional(),
  protein: z.number().min(0).max(100).nullish(),
  fat: z.number().min(0).max(100).nullish(),
  satfat: z.number().min(0).max(100).nullish(),
  carbs: z.number().min(0).max(100).nullish(),
  sugar: z.number().min(0).max(100).nullish(),
  url: z.string().url().max(500).optional(),
});

const SYSTEM = `Найди пищевую ценность товара в интернете: сайт производителя, магазин с фото этикетки или база продуктов.
Нужны значения на 100 г (для напитков — на 100 мл), ровно как напечатано: ккал, белки, жиры, в т.ч. насыщенные, углеводы, в т.ч. сахара.
Никогда не оценивай и не усредняй. Если точного товара нет — found: false.
Ответь ТОЛЬКО JSON: {"found": true, "name": "...", "brand": "...", "basis": "100g" | "100ml", "kcal": 0, "protein": 0, "fat": 0, "satfat": null, "carbs": 0, "sugar": null, "url": "https://страница-с-цифрами"} или {"found": false}.`;

function firstJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Web search was verified on the plan for this model (D26); WEB_SEARCH_MODEL overrides it. */
const WEB_MODEL = process.env.WEB_SEARCH_MODEL?.trim() || 'gpt-6.1-sol';

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** A checked web result or null (not found, inconsistent numbers, or a URL that was not searched). */
export async function webNutrition(userId: string, query: string, runId?: string | null): Promise<WebFood | null> {
  const spec = { model: WEB_MODEL, effort: 'low' as const };
  const res = await callModel(spec, { userId, runId, purpose: 'web_lookup' }, async (model) => {
    const st = streamText({
      model, instructions: SYSTEM, prompt: query.slice(0, 200),
      tools: { web_search: openai.tools.webSearch({ searchContextSize: 'low' }) },
      stopWhen: isStepCount(4), maxRetries: 0, timeout: 60_000, providerOptions: planOptions(spec),
    });
    const [text, sources, usage] = await Promise.all([st.text, st.sources, st.usage]);
    const urls = sources.flatMap((s) => (s.sourceType === 'url' ? [s.url] : []));
    return { value: { text, urls }, usage };
  });
  const parsed = Answer.safeParse(firstJson(res.result.text));
  if (!parsed.success || !parsed.data.found) return null;
  const a = parsed.data;
  const { kcal, url, name } = a;
  if (kcal == null || !url || !name) return null;
  // The page must be one the search actually returned (same host at least).
  const searched = res.result.urls.map(host);
  if (searched.length && !searched.includes(host(url))) return null;
  const check = checkLabelNumbers(kcal, a.protein ?? 0, a.fat ?? 0, a.carbs ?? 0);
  if (check.kcalMismatch || check.macroSumTooHigh) return null;
  return {
    name, brand: a.brand ?? null, basis: a.basis ?? '100g', url,
    per100: { kcal, protein: a.protein ?? null, fat: a.fat ?? null, carbs: a.carbs ?? null, satfat: a.satfat ?? null, sugar: a.sugar ?? null },
  };
}
