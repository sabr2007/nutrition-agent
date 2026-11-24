/**
 * Photo-accuracy eval harness.
 *
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json node --conditions=react-server --env-file=.env.local \
 *     --import tsx eval/photo-eval.ts --source n5k --n 20 --models "@cf/mistralai/mistral-small-3.1-24b-instruct,@cf/meta/llama-4-scout-17b-16e-instruct"
 *
 * Sources:
 *   n5k      Nutrition5k (Thames et al., CVPR 2021, CC BY 4.0): overhead RGB + weighed ground truth.
 *            Deterministic sample from the official depth_test split (dishes from cafe1).
 *   labeled  The owner's "размеченный приём" meals (exact grams from a kitchen scale) with photos.
 *
 * Exactly the production pipeline pieces: same prompt version, JSON schema, food DB matching
 * (search_foods), deterministic macro calculation, and self-consistency aggregation.
 * Metrics: MAE / MAPE for kcal, protein, fat, carbs and mass; item count; calibration
 * (confidence bins vs. absolute % error). Results → eval/results/*.json + docs/research/eval-results.md.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { genObject } from '@/lib/llm/generate';
import { RecognitionOutput, sanitize } from '@/lib/recognition/schema';
import { PHOTO_PROMPT_VERSION, PIPELINE_VERSION, photoSystemPrompt } from '@/lib/recognition/prompts';
import { pickBest, searchFoodsSmart } from '@/lib/recognition/match';
import { clusterRuns, overallAgreement, summarize, type RunItem } from '@/lib/recognition/aggregate';
import { macrosFor } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';
import type { ProviderId } from '@/lib/llm/providers';

const ROOT = process.cwd();
const N5K = 'https://storage.googleapis.com/nutrition5k_dataset/nutrition5k_dataset';
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };

type Truth = { id: string; kcal: number; mass: number; fat: number; carbs: number; protein: number; ingredients: string[]; image: () => Promise<Uint8Array> };
type Pred = { kcal: number; mass: number; fat: number; carbs: number; protein: number; confidence: number; agreement: number | null; items: string[]; unmatched: number; latencyMs: number; error?: string };

function loadN5k(n: number): Truth[] {
  const dir = path.join(ROOT, 'eval/data/n5k');
  const meta = readFileSync(path.join(dir, 'dish_metadata_cafe1.csv'), 'utf8').trim().split('\n');
  const test = new Set(readFileSync(path.join(dir, 'depth_test_ids.txt'), 'utf8').trim().split('\n').map((s) => s.trim()));
  const rows = meta.map((line) => line.split(',')).filter((c) => test.has(c[0]) && Number(c[1]) > 30);
  // deterministic sample: sort by id, take every k-th
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const step = Math.max(1, Math.floor(rows.length / n));
  return rows.filter((_, i) => i % step === 0).slice(0, n).map((c) => {
    const ingredients: string[] = [];
    for (let i = 6; i + 6 < c.length; i += 7) ingredients.push(`${c[i + 1]} ${Math.round(Number(c[i + 2]))}g`);
    const id = c[0];
    return {
      id, kcal: Number(c[1]), mass: Number(c[2]), fat: Number(c[3]), carbs: Number(c[4]), protein: Number(c[5]), ingredients,
      image: async () => {
        const file = path.join(dir, `${id}.png`);
        if (!existsSync(file)) {
          const res = await fetch(`${N5K}/imagery/realsense_overhead/${id}/rgb.png`);
          if (!res.ok) throw new Error(`image ${id}: ${res.status}`);
          writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        }
        return new Uint8Array(readFileSync(file));
      },
    };
  });
}

async function loadLabeled(sb: SupabaseClient, n: number): Promise<Truth[]> {
  const { data } = await sb.from('meals').select('id, kcal, protein_g, fat_g, carbs_g, recognition_id, meal_items(name, grams), recognitions(media_ids)')
    .eq('is_labeled', true).eq('is_current', true).eq('status', 'confirmed').not('recognition_id', 'is', null).limit(n);
  const out: Truth[] = [];
  for (const m of data ?? []) {
    const mediaIds = ((m.recognitions as unknown as { media_ids: string[] } | null)?.media_ids) ?? [];
    if (!mediaIds.length) continue;
    const { data: media } = await sb.from('media').select('bucket, path').eq('id', mediaIds[0]).single();
    if (!media) continue;
    const items = (m.meal_items ?? []) as { name: string; grams: number }[];
    out.push({
      id: m.id as string, kcal: Number(m.kcal), protein: Number(m.protein_g), fat: Number(m.fat_g), carbs: Number(m.carbs_g),
      mass: items.reduce((a, i) => a + Number(i.grams), 0), ingredients: items.map((i) => `${i.name} ${Number(i.grams)}g`),
      image: async () => new Uint8Array(await (await sb.storage.from(media.bucket as string).download(media.path as string)).data!.arrayBuffer()),
    });
  }
  return out;
}

async function predict(sb: SupabaseClient, img: Uint8Array, models: string[], provider: ProviderId, cache: Map<string, Food[]>): Promise<Pred> {
  const t0 = Date.now();
  const runs = await Promise.allSettled(models.map((model, i) => genObject({
    task: 'vision', log: { purpose: 'eval_vision' }, system: photoSystemPrompt(),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Распознай еду на фото.' }, { type: 'file', mediaType: 'image/png', data: img }] }],
    schema: RecognitionOutput, models: [{ provider, model }], noBreaker: true, temperature: i === 0 ? 0.2 : 0.7, timeoutMs: 120_000,
  })));
  const outputs = runs.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof genObject<typeof RecognitionOutput>>>> => r.status === 'fulfilled').map((r) => sanitize(r.value.result));
  if (!outputs.length) {
    const reason = runs.map((r) => (r.status === 'rejected' ? String((r.reason as Error)?.message).slice(0, 120) : '')).join(' | ');
    return { kcal: 0, mass: 0, fat: 0, carbs: 0, protein: 0, confidence: 0, agreement: null, items: [], unmatched: 0, latencyMs: Date.now() - t0, error: reason };
  }
  const matched: RunItem[][] = [];
  for (const [ri, o] of outputs.entries()) {
    matched.push(await Promise.all(o.items.map(async (it) => {
      const q = it.food_query.trim();
      if (!cache.has(q)) cache.set(q, await searchFoodsSmart(sb, q, 6));
      const best = pickBest(cache.get(q)!, it.state, undefined, q);
      return { ...it, run: ri, food: best?.food ?? null, quality: best?.quality ?? 0.4 };
    })));
  }
  const sums = clusterRuns(matched).map((c) => summarize(c, outputs.length)).filter((s) => !(outputs.length > 1 && s.presence < 0.5 && s.confidence < 0.25));
  let kcal = 0, protein = 0, fat = 0, carbs = 0, mass = 0, unmatched = 0;
  for (const s of sums) {
    mass += s.grams;
    if (!s.food) { unmatched++; continue; }
    const m = macrosFor(s.grams, { kcal: Number(s.food.kcal_100g), protein: Number(s.food.protein_100g), fat: Number(s.food.fat_100g), carbs: Number(s.food.carbs_100g) });
    kcal += m.kcal; protein += m.protein_g; fat += m.fat_g; carbs += m.carbs_g;
  }
  const agreement = outputs.length > 1 ? overallAgreement(sums) : null;
  const modelConf = outputs.reduce((a, o) => a + o.overall_confidence, 0) / outputs.length;
  return {
    kcal, protein, fat, carbs, mass, agreement, unmatched, latencyMs: Date.now() - t0,
    confidence: Math.min(modelConf, agreement ?? 1),
    items: sums.map((s) => `${s.food?.name_ru ?? `?${s.representative.food_query}`} ${s.grams}г`),
  };
}

function metrics(rows: { t: Truth; p: Pred }[]) {
  const ok = rows.filter((r) => !r.p.error);
  const mae = (f: (r: { t: Truth; p: Pred }) => number) => ok.reduce((a, r) => a + Math.abs(f(r)), 0) / Math.max(1, ok.length);
  const mape = (pick: (x: Truth | Pred) => number) => (ok.reduce((a, r) => a + Math.abs(pick(r.p) - pick(r.t)) / Math.max(1, pick(r.t)), 0) / Math.max(1, ok.length)) * 100;
  const meanTruth = ok.reduce((a, r) => a + r.t.kcal, 0) / Math.max(1, ok.length);
  // calibration: confidence bins vs mean absolute % kcal error
  const bins = [[0, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const inBin = ok.filter((r) => r.p.confidence >= lo && r.p.confidence < hi);
    return { bin: `${lo}–${Math.min(hi, 1)}`, n: inBin.length, mape_kcal: inBin.length ? Math.round((inBin.reduce((a, r) => a + Math.abs(r.p.kcal - r.t.kcal) / Math.max(1, r.t.kcal), 0) / inBin.length) * 100) : null };
  });
  // Spearman-ish: correlation between confidence and |error|
  const xs = ok.map((r) => r.p.confidence); const ys = ok.map((r) => Math.abs(r.p.kcal - r.t.kcal) / Math.max(1, r.t.kcal));
  const mx = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); const my = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
  const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0); const vx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0)); const vy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return {
    n: rows.length, ok: ok.length, failed: rows.length - ok.length,
    mae_kcal: Math.round(mae((r) => r.p.kcal - r.t.kcal)), mape_kcal: Math.round(mape((x) => x.kcal)),
    mae_over_mean_pct: Math.round((mae((r) => r.p.kcal - r.t.kcal) / Math.max(1, meanTruth)) * 100),
    mae_protein: Number(mae((r) => r.p.protein - r.t.protein).toFixed(1)), mae_fat: Number(mae((r) => r.p.fat - r.t.fat).toFixed(1)), mae_carbs: Number(mae((r) => r.p.carbs - r.t.carbs).toFixed(1)),
    mae_mass: Math.round(mae((r) => r.p.mass - r.t.mass)), mape_mass: Math.round(mape((x) => x.mass)),
    mean_truth_kcal: Math.round(meanTruth), avg_latency_ms: Math.round(ok.reduce((a, r) => a + r.p.latencyMs, 0) / Math.max(1, ok.length)),
    unmatched_items: ok.reduce((a, r) => a + r.p.unmatched, 0),
    calibration: bins, corr_conf_vs_abs_err: vx && vy ? Number((cov / (vx * vy)).toFixed(2)) : null,
  };
}

async function main() {
  const source = arg('source', 'n5k')!;
  const n = Number(arg('n', '20'));
  const provider = (arg('provider', 'workers-ai') as ProviderId);
  const models = (arg('models', '@cf/mistralai/mistral-small-3.1-24b-instruct')!).split(',').map((s) => s.trim()).filter(Boolean);
  const concurrency = Number(arg('concurrency', '4'));
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!, { auth: { persistSession: false } });
  const truths = source === 'labeled' ? await loadLabeled(sb, n) : loadN5k(n);
  console.log(`eval: source=${source} dishes=${truths.length} provider=${provider} models=${models.join('+')}`);
  const cache = new Map<string, Food[]>();
  const rows: { t: Truth; p: Pred }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < truths.length) {
      const t = truths[next++];
      try {
        const p = await predict(sb, await t.image(), models, provider, cache);
        rows.push({ t, p });
        console.log(`${t.id}: truth ${Math.round(t.kcal)} kcal / pred ${Math.round(p.kcal)} (${p.error ? 'ERR ' + p.error : `conf ${p.confidence.toFixed(2)}`})`);
      } catch (e) {
        rows.push({ t, p: { kcal: 0, mass: 0, fat: 0, carbs: 0, protein: 0, confidence: 0, agreement: null, items: [], unmatched: 0, latencyMs: 0, error: (e as Error).message } });
      }
    }
  }));
  const m = metrics(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync(path.join(ROOT, 'eval/results'), { recursive: true });
  const config = { source, n: truths.length, provider, models, samples: models.length, pipeline: PIPELINE_VERSION, prompt: PHOTO_PROMPT_VERSION, db: 'seed foods v1 (147 rows)', date: new Date().toISOString() };
  writeFileSync(path.join(ROOT, `eval/results/${stamp}-${source}.json`), JSON.stringify({ config, metrics: m, rows: rows.map((r) => ({ id: r.t.id, truth: { kcal: r.t.kcal, mass: r.t.mass, protein: r.t.protein, fat: r.t.fat, carbs: r.t.carbs, ingredients: r.t.ingredients }, pred: r.p })) }, null, 2));
  const md = `| ${config.date.slice(0, 16)} | ${source} | ${m.ok}/${m.n} | ${models.map((x) => x.split('/').pop()).join(' + ')} | ${PROMPT_LABEL()} | ${m.mae_kcal} | ${m.mape_kcal}% | ${m.mae_over_mean_pct}% | ${m.mae_protein} / ${m.mae_fat} / ${m.mae_carbs} | ${m.mae_mass} (${m.mape_mass}%) | ${m.corr_conf_vs_abs_err ?? '—'} | ${Math.round(m.avg_latency_ms / 1000)} с |\n`;
  const doc = path.join(ROOT, 'docs/research/eval-results.md');
  if (!existsSync(doc)) writeFileSync(doc, EVAL_HEADER);
  appendFileSync(doc, md);
  console.log(JSON.stringify(m, null, 2));
}

const PROMPT_LABEL = () => `${PIPELINE_VERSION}/${PHOTO_PROMPT_VERSION}`;
const EVAL_HEADER = `# Точность распознавания еды по фото — результаты eval

Харнесс: \`eval/photo-eval.ts\` (тот же промпт, JSON-схема, сопоставление с базой и детерминированный расчёт КБЖУ, что и в проде). Сырые результаты по каждому блюду — \`eval/results/*.json\`.

- **MAE ккал** — средняя абсолютная ошибка по блюду; **MAPE** — средняя абсолютная ошибка в % от эталона блюда; **MAE/среднее** — MAE, делённая на среднюю калорийность (так считает статья Nutrition5k, их «26.1%»).
- **corr(conf, |err|)** — корреляция уверенности с относительной ошибкой: хорошая калибровка = отрицательное значение (выше уверенность → меньше ошибка).
- Ориентиры из литературы (docs/research/photo-accuracy.md): Nutrition5k обученная модель — MAE 70.6 ккал (26.1% от среднего); Gemini 3.0 Flash zero-shot на тех же фото — MAE 80.7 ккал, MAPE 44.4%; GPT-4o — 82.9 ккал, 41.7%.

| дата | источник | ок/n | модели (прогоны) | пайплайн/промпт | MAE ккал | MAPE ккал | MAE/среднее | MAE Б/Ж/У, г | MAE масса, г | corr(conf,|err|) | латентность |
|---|---|---|---|---|---|---|---|---|---|---|---|
`;

main().catch((e) => { console.error(e); process.exit(1); });
