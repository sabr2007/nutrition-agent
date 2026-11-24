import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModelMessage } from 'ai';
import { genObject } from '@/lib/llm/generate';
import { costUsd } from '@/lib/llm/pricing';
import { itemFromFood, gramsForPortion, r1 } from '@/lib/nutrition/calc';
import type { Food, MealItemInput } from '@/lib/nutrition/types';
import { RecognitionOutput, sanitize, type ClarifyingQuestion } from './schema';
import { PIPELINE_VERSION, PHOTO_PROMPT_VERSION, TEXT_PROMPT_VERSION, photoSystemPrompt, textSystemPrompt, userContext, type Hints } from './prompts';
import { pickBest, searchFoods, searchFoodsSmart } from './match';
import { calibrationRatio, clusterRuns, summarize, type RunItem } from './aggregate';
import { quickParse } from './quickparse';

export type ProposedItem = MealItemInput & {
  key: string;
  label: string;
  food_query: string;
  grams_low: number;
  grams_high: number;
  presence: number;
  unmatched: boolean;
  alternatives: { id: string; name_ru: string; state: string }[];
};

export type RecognitionResult = {
  recognitionId: string | null;
  kind: 'photo' | 'text' | 'voice' | 'scale';
  items: ProposedItem[];
  questions: ClarifyingQuestion[];
  confidence: number;
  agreement: number | null;
  scaleReadingG: number | null;
  notes: string | null;
  usedLlm: boolean;
  models: string[];
};

type RunMeta = { provider: string; model: string; latency_ms: number; tokens_in?: number; tokens_out?: number; cost_usd: number; raw?: unknown; error?: string };

const PHOTO_TIMEOUT_MS = 120_000;

/** Frequent foods + recent corrections → prompt context and calibration. */
export async function personalContext(sb: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [{ data: items }, { data: corr }, { data: tmpl }] = await Promise.all([
    sb.from('meal_items').select('name, food_id, meals!inner(eaten_at, is_current, status)').eq('user_id', userId)
      .gte('meals.eaten_at', since).eq('meals.is_current', true).eq('meals.status', 'confirmed').limit(400),
    sb.from('meal_corrections').select('item_label, food_id_after, grams_before, grams_after, kind, created_at')
      .eq('user_id', userId).eq('kind', 'grams').order('created_at', { ascending: false }).limit(60),
    sb.from('meal_template_items').select('food_id').eq('user_id', userId),
  ]);
  const preferred = new Map<string, number>();
  for (const t of tmpl ?? []) preferred.set(t.food_id as string, (preferred.get(t.food_id as string) ?? 0) + 5);
  for (const it of items ?? []) if (it.food_id) preferred.set(it.food_id as string, (preferred.get(it.food_id as string) ?? 0) + 1);
  const freq = new Map<string, number>();
  for (const it of items ?? []) freq.set(it.name as string, (freq.get(it.name as string) ?? 0) + 1);
  const frequentFoods = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n]) => n);
  const byFood = new Map<string, number[]>();
  for (const c of corr ?? []) {
    if (!c.food_id_after || !c.grams_before || !c.grams_after) continue;
    const arr = byFood.get(c.food_id_after as string) ?? [];
    arr.push(Number(c.grams_after) / Number(c.grams_before));
    byFood.set(c.food_id_after as string, arr);
  }
  const calibration = new Map<string, number>();
  for (const [foodId, ratios] of byFood) calibration.set(foodId, calibrationRatio(ratios));
  const corrections = (corr ?? []).slice(0, 6).filter((c) => c.grams_before && c.grams_after)
    .map((c) => `«${c.item_label}»: оценка ${Math.round(Number(c.grams_before))} г → на самом деле ${Math.round(Number(c.grams_after))} г`);
  return { frequentFoods, corrections, calibration, preferred };
}

async function matchItems(sb: SupabaseClient, items: RecognitionOutput['items'], run: number, cache: Map<string, Food[]>, preferred?: Map<string, number>): Promise<RunItem[]> {
  return Promise.all(items.map(async (it) => {
    const q = it.food_query.trim();
    let results = cache.get(q);
    if (!results) {
      results = await searchFoodsSmart(sb, q, 6);
      cache.set(q, results);
    }
    const best = pickBest(results, it.state, preferred, q);
    return { ...it, label_ru: it.label_ru || it.food_query, run, food: best?.food ?? null, quality: best?.quality ?? 0.4 };
  }));
}

function toProposed(summaries: ReturnType<typeof summarize>[], cache: Map<string, Food[]>, calibration: Map<string, number>, source: 'model' | 'user'): ProposedItem[] {
  return summaries.map((s) => {
    const rep = s.representative;
    const alts = (cache.get(rep.food_query.trim()) ?? []).filter((f) => f.id !== s.food?.id).slice(0, 4)
      .map((f) => ({ id: f.id, name_ru: f.name_ru, state: f.state }));
    const ratio = s.food ? calibration.get(s.food.id) ?? 1 : 1;
    const grams = Math.max(1, Math.round(s.grams * ratio));
    if (!s.food) {
      return {
        key: s.key, label: rep.label_ru, food_query: rep.food_query, food_id: null, name: rep.label_ru, grams,
        state: rep.state, per100: null, kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, confidence: Math.min(s.confidence, 0.3),
        source, model_grams: s.grams, model_label: rep.label_ru, edited: false, kcal_range: null,
        grams_low: s.gramsLow, grams_high: s.gramsHigh, presence: s.presence, unmatched: true, alternatives: alts,
      };
    }
    const base = itemFromFood(s.food, grams, { source, confidence: s.confidence, model_grams: s.grams, model_label: rep.label_ru });
    return {
      ...base, key: s.key, label: rep.label_ru, food_query: rep.food_query,
      grams_low: Math.round(s.gramsLow * ratio), grams_high: Math.round(s.gramsHigh * ratio),
      presence: s.presence, unmatched: false, alternatives: alts,
    };
  });
}

/** Adds a portion question automatically when runs disagree on a high-energy item. */
function autoQuestions(items: ProposedItem[], existing: ClarifyingQuestion[]): ClarifyingQuestion[] {
  const out = [...existing];
  if (out.length >= 2) return out.slice(0, 2);
  const candidatesForQ = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => !it.unmatched && it.kcal >= 120 && it.grams_high > it.grams_low * 1.5)
    .sort((a, b) => b.it.kcal - a.it.kcal);
  for (const { it, index } of candidatesForQ) {
    if (out.length >= 2) break;
    if (out.some((q) => q.options.some((o) => o.item_index === index))) continue;
    const mid = Math.round(it.grams / 10) * 10;
    const low = Math.max(10, Math.round(it.grams_low / 10) * 10);
    const high = Math.round(it.grams_high / 10) * 10;
    const opts = [...new Set([low, mid, high])].filter((g) => g > 0);
    if (opts.length < 2) continue;
    out.push({
      id: `auto-${index}`,
      text: `${it.label}: сколько примерно?`,
      options: opts.map((g) => ({ label: `~${g} г`, effect: 'set_grams' as const, item_index: index, grams: g, food_query: null })),
    });
  }
  return out;
}

async function saveRecognition(sb: SupabaseClient, userId: string, row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await sb.from('recognitions').insert({ user_id: userId, ...row }).select('id').single();
  if (error) {
    console.error('[recognition] save failed', error.message);
    return null;
  }
  return data.id as string;
}

export async function recognizePhoto(opts: {
  sb: SupabaseClient; userId: string; images: { data: Uint8Array; mime: string }[]; mediaIds: string[]; hints: Hints;
}): Promise<RecognitionResult> {
  const t0 = Date.now();
  const ctx = await personalContext(opts.sb, opts.userId);
  const hints: Hints = { ...opts.hints, frequentFoods: ctx.frequentFoods, corrections: ctx.corrections };
  const kind = opts.hints.mode === 'scale' ? 'scale' : 'photo';
  const userText = ['Распознай еду на фото.', userContext(hints)].filter(Boolean).join('\n');
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: userText },
      ...opts.images.map((img) => ({ type: 'file' as const, mediaType: img.mime || 'image/jpeg', data: img.data })),
    ],
  }];

  let attempt;
  try {
    attempt = await genObject({
      task: 'vision',
      log: { userId: opts.userId, purpose: 'vision' },
      system: photoSystemPrompt(),
      messages,
      schema: RecognitionOutput,
      timeoutMs: PHOTO_TIMEOUT_MS,
    });
  } catch (err) {
    await saveRecognition(opts.sb, opts.userId, {
      kind, media_ids: opts.mediaIds, hints: opts.hints, pipeline_version: PIPELINE_VERSION,
      prompt_version: PHOTO_PROMPT_VERSION, runs: [], status: 'error', error: (err as Error).message.slice(0, 300), latency_ms: Date.now() - t0,
    });
    throw err;
  }
  const out = sanitize(attempt.result);
  const run: RunMeta = {
    provider: 'chatgpt', model: attempt.model, latency_ms: attempt.latencyMs,
    tokens_in: attempt.usage?.inputTokens, tokens_out: attempt.usage?.outputTokens,
    cost_usd: costUsd(attempt.model, attempt.usage?.inputTokens, attempt.usage?.outputTokens), raw: out,
  };

  const cache = new Map<string, Food[]>();
  const matched = await matchItems(opts.sb, out.items, 0, cache, ctx.preferred);
  const summaries = clusterRuns([matched]).map((c) => summarize(c, 1));
  let items = toProposed(summaries, cache, ctx.calibration, 'model');

  // Kitchen-scale mode: a visible reading is the ground truth for a single item.
  const reading = typeof out.scale_reading_g === 'number' && out.scale_reading_g > 0 ? out.scale_reading_g : null;
  if (reading && items.length === 1 && items[0].per100) {
    const it = items[0];
    items = [{ ...it, ...itemFromFood({ ...(cache.get(it.food_query.trim())?.find((f) => f.id === it.food_id) as Food) }, reading, { source: 'scale', confidence: 0.95, model_grams: it.model_grams, model_label: it.label }), key: it.key, label: it.label, food_query: it.food_query, grams_low: reading, grams_high: reading, presence: 1, unmatched: false, alternatives: it.alternatives }];
  }

  const kcalTotal = items.reduce((a, i) => a + i.kcal, 0) || 1;
  const itemConf = items.reduce((a, i) => a + (i.confidence ?? 0) * Math.max(i.kcal, 1), 0) / kcalTotal;
  const confidence = Number(Math.min(out.overall_confidence, itemConf || out.overall_confidence).toFixed(3));
  const questions = confidence < 0.75 ? autoQuestions(items, out.questions) : out.questions.slice(0, 1);

  const recognitionId = await saveRecognition(opts.sb, opts.userId, {
    kind, media_ids: opts.mediaIds, hints: opts.hints,
    pipeline_version: PIPELINE_VERSION, prompt_version: PHOTO_PROMPT_VERSION, runs: [run],
    result: { items, scale_reading_g: reading, notes: out.notes, hidden: out.hidden_ingredients },
    agreement: null, confidence, questions, status: 'done', latency_ms: Date.now() - t0, cost_usd: run.cost_usd,
  });

  return {
    recognitionId, kind, items, questions, confidence, agreement: null,
    scaleReadingG: reading, notes: out.notes, usedLlm: true, models: [attempt.model],
  };
}

/** Text or voice transcript → items. Simple inputs skip the LLM entirely. */
export async function parseFoodText(opts: {
  sb: SupabaseClient; userId: string; text: string; kind: 'text' | 'voice'; mediaIds?: string[]; transcript?: string | null; hints?: Hints;
}): Promise<RecognitionResult> {
  const t0 = Date.now();
  const text = opts.text.trim();
  const cache = new Map<string, Food[]>();

  const quick = quickParse(text);
  const ctx = await personalContext(opts.sb, opts.userId);
  if (quick) {
    const resolved = await Promise.all(quick.map(async (seg) => {
      const results = await searchFoods(opts.sb, seg.query, 6);
      cache.set(seg.query, results);
      const best = pickBest(results, seg.state, ctx.preferred, seg.query);
      return { seg, best };
    }));
    if (resolved.every((r) => r.best && r.best.quality >= 0.7)) {
      const items: ProposedItem[] = resolved.map(({ seg, best }, idx) => {
        const food = best!.food;
        const grams = seg.grams ?? (seg.count ? gramsForPortion(food, seg.count) : null) ?? Number(food.default_portion_g ?? 100);
        const conf = seg.grams ? 0.9 : seg.count ? 0.8 : 0.6;
        const base = itemFromFood(food, grams, { source: 'user', confidence: conf });
        return {
          ...base, key: `q${idx}`, label: food.name_ru, food_query: seg.query,
          grams_low: r1(grams * (seg.grams ? 1 : 0.7)), grams_high: r1(grams * (seg.grams ? 1 : 1.4)),
          presence: 1, unmatched: false,
          alternatives: (cache.get(seg.query) ?? []).filter((f) => f.id !== food.id).slice(0, 4).map((f) => ({ id: f.id, name_ru: f.name_ru, state: f.state })),
        };
      });
      const confidence = Math.min(...items.map((i) => i.confidence ?? 0.6));
      const recognitionId = await saveRecognition(opts.sb, opts.userId, {
        kind: opts.kind, media_ids: opts.mediaIds ?? [], input_text: text, transcript: opts.transcript ?? null,
        pipeline_version: PIPELINE_VERSION, prompt_version: 'quickparse-v1', runs: [], result: { items },
        confidence, status: 'done', latency_ms: Date.now() - t0, cost_usd: 0,
      });
      return { recognitionId, kind: opts.kind, items, questions: [], confidence, agreement: null, scaleReadingG: null, notes: null, usedLlm: false, models: [] };
    }
  }

  const hints: Hints = { ...(opts.hints ?? {}), frequentFoods: ctx.frequentFoods, corrections: ctx.corrections };
  const res = await genObject({
    task: 'parse',
    log: { userId: opts.userId, purpose: opts.kind === 'voice' ? 'parse_voice' : 'parse_text' },
    system: textSystemPrompt(),
    messages: [{ role: 'user', content: `${userContext(hints)}\n\nТекст: «${text.slice(0, 1500)}»` }],
    schema: RecognitionOutput,
  });
  const out = sanitize(res.result);
  const matched = await matchItems(opts.sb, out.items, 0, cache, ctx.preferred);
  const summaries = clusterRuns([matched]).map((c) => summarize(c, 1));
  const items = toProposed(summaries, cache, new Map(), 'model');
  const confidence = Number(Math.min(out.overall_confidence, ...items.map((i) => i.confidence ?? 0.5), 1).toFixed(3));
  const questions = autoQuestions(items, out.questions).slice(0, 2);
  const runMeta: RunMeta[] = [{
    provider: 'chatgpt', model: res.model, latency_ms: res.latencyMs,
    tokens_in: res.usage?.inputTokens, tokens_out: res.usage?.outputTokens,
    cost_usd: costUsd(res.model, res.usage?.inputTokens, res.usage?.outputTokens), raw: out,
  }];
  const recognitionId = await saveRecognition(opts.sb, opts.userId, {
    kind: opts.kind, media_ids: opts.mediaIds ?? [], input_text: text, transcript: opts.transcript ?? null,
    pipeline_version: PIPELINE_VERSION, prompt_version: TEXT_PROMPT_VERSION, runs: runMeta, result: { items },
    confidence, questions, status: 'done', latency_ms: Date.now() - t0, cost_usd: runMeta[0].cost_usd,
  });
  return { recognitionId, kind: opts.kind, items, questions, confidence, agreement: null, scaleReadingG: null, notes: out.notes, usedLlm: true, models: [res.model] };
}
