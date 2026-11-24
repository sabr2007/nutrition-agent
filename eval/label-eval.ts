/**
 * Nutrition-label reading eval: synthetic label photos (eval/fixtures/labels, rendered by
 * make.mjs) → vision model → normalizeLabel → compare with the printed values.
 *
 *   pnpm eval:label [--models <provider/model,...>]
 *
 * A fixture passes when kcal is within ±1 and every macro within ±0.15 g of the label.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { genObject } from '@/lib/llm/generate';
import { LABEL_PROMPT_VERSION, LabelOutput, labelSystemPrompt, normalizeLabel } from '@/lib/recognition/label';
import type { ModelRef } from '@/lib/llm/providers';
import { labelModelOrder } from '@/lib/recognition/label-read';

type Expected = { kcal: number; protein: number; fat: number; carbs: number; state?: string; servingG?: number };

const FIXTURES: Record<string, Expected> = {
  'table-100g': { kcal: 355, protein: 11.9, fat: 7.2, carbs: 60.5, state: 'dry' },
  'paragraph-eaeu': { kcal: 308, protein: 12.6, fat: 3.3, carbs: 57.1, state: 'dry' },
  'per-serving': { kcal: 450, protein: 9, fat: 18, carbs: 62, state: 'as_is', servingG: 30 },
  'per-serving-only': { kcal: 358.3, protein: 33.3, fat: 11.7, carbs: 30, state: 'as_is', servingG: 60 },
  'milk-ml': { kcal: 52, protein: 3, fat: 2.5, carbs: 4.7, state: 'as_is' },
  'photo-skewed': { kcal: 355, protein: 11.9, fat: 7.2, carbs: 60.5, state: 'dry' },
};
const KCAL_TOL = 1;
const MACRO_TOL = 0.15;
const CONCURRENCY = 3;

const dir = path.join(process.cwd(), 'eval', 'fixtures', 'labels');
const modelsArg = (() => { const i = process.argv.indexOf('--models'); return i >= 0 ? process.argv[i + 1] : undefined; })();
// Default: the same model order the app uses for labels.
const models: ModelRef[] = modelsArg?.split(',').map((s) => { const [provider, ...rest] = s.split('/'); return { provider, model: rest.join('/') } as ModelRef; }) ?? labelModelOrder(null);

type Row = { name: string; ok: boolean; ms: number; model: string; got: string; issue?: string };

async function run(name: string, exp: Expected): Promise<Row> {
  const data = readFileSync(path.join(dir, `${name}.jpg`));
  const messages: ModelMessage[] = [{ role: 'user', content: [
    { type: 'text', text: 'Перепиши пищевую ценность с этикетки на фото.' },
    { type: 'file', mediaType: 'image/jpeg', data: new Uint8Array(data) },
  ] }];
  const t0 = Date.now();
  try {
    const a = await genObject({ task: 'vision', log: { purpose: 'eval_label' }, system: labelSystemPrompt(), messages, schema: LabelOutput, temperature: 0, timeoutMs: 90_000, maxOutputTokens: 900, models, noBreaker: true });
    const l = normalizeLabel(a.result);
    const p = l.per100;
    const bad = [
      Math.abs(p.kcal - exp.kcal) > KCAL_TOL && `kcal ${p.kcal}≠${exp.kcal}`,
      Math.abs(p.protein - exp.protein) > MACRO_TOL && `б ${p.protein}≠${exp.protein}`,
      Math.abs(p.fat - exp.fat) > MACRO_TOL && `ж ${p.fat}≠${exp.fat}`,
      Math.abs(p.carbs - exp.carbs) > MACRO_TOL && `у ${p.carbs}≠${exp.carbs}`,
      exp.servingG && l.servingG !== exp.servingG && `порция ${l.servingG}≠${exp.servingG}`,
    ].filter(Boolean) as string[];
    const stateNote = exp.state && l.state !== exp.state ? ` (state ${l.state}≠${exp.state})` : '';
    return { name, ok: !bad.length, ms: Date.now() - t0, model: a.ref.model, got: `${p.kcal}/${p.protein}/${p.fat}/${p.carbs}${stateNote}`, issue: bad.join(', ') || undefined };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, model: '-', got: '-', issue: (e as Error).message.slice(0, 160) };
  }
}

const names = Object.keys(FIXTURES);
const rows: Row[] = [];
for (let i = 0; i < names.length; i += CONCURRENCY) {
  rows.push(...await Promise.all(names.slice(i, i + CONCURRENCY).map((n) => run(n, FIXTURES[n]))));
}
for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(17)} ${String(r.ms).padStart(6)} ms  ${r.model}  ккал/б/ж/у ${r.got}${r.issue ? `  — ${r.issue}` : ''}`);
const passed = rows.filter((r) => r.ok).length;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const median = ms[Math.floor(ms.length / 2)];
const usedModels = [...new Set(rows.map((r) => r.model).filter((m) => m !== '-'))].join(', ');
console.log(`\n${passed}/${rows.length} passed · median ${median} ms · ${usedModels}`);
const stamp = new Date().toISOString().slice(0, 16);
appendFileSync(path.join(process.cwd(), 'docs', 'research', 'eval-results.md'),
  `| ${stamp} | labels | ${passed}/${rows.length} | ${usedModels || '-'} | ${LABEL_PROMPT_VERSION} | точное совпадение ккал ±${KCAL_TOL}, БЖУ ±${MACRO_TOL} г | медиана ${Math.round(median / 1000)} с |\n`);
