import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModelMessage } from 'ai';
import { genObject } from '@/lib/llm/generate';
import { getChatgptToken } from '@/lib/llm/chatgpt';
import { costUsd } from '@/lib/llm/pricing';
import { candidates, type ModelRef } from '@/lib/llm/providers';
import { LABEL_PROMPT_VERSION, LabelOutput, labelSystemPrompt, normalizeLabel, type NormalizedLabel } from './label';

export type LabelReadResult = { recognitionId: string | null; label: NormalizedLabel; model: string; latencyMs: number };

export class LabelUnreadableError extends Error {}

const LABEL_TIMEOUT_MS = 90_000;
const LABEL_MAX_OUTPUT_TOKENS = 900;
// eval/label-eval.ts: Qwen 3.8 27B 6/6 (median ~13 s), Llama 4 Scout 6/6 (~7 s); Mistral Small
// loops on whitespace with this schema, so it is left out of label reading.
const LABEL_FALLBACK: ModelRef = { provider: 'workers-ai', model: '@cf/meta/llama-4-scout-17b-16e-instruct' };
const EXCLUDED = /mistral/i;

/** Vision route (ChatGPT / Gateway first when enabled) without Mistral, Scout as the last resort. */
export function labelModelOrder(chatgptAccessToken: string | null): ModelRef[] {
  const pool = candidates('vision', { chatgptAccessToken }).filter((m) => !EXCLUDED.test(m.model));
  return pool.some((m) => m.model === LABEL_FALLBACK.model) ? pool : [...pool, LABEL_FALLBACK];
}

/**
 * Reads a nutrition label photo: one vision call (transcription only), deterministic
 * normalization, and the raw model output stored in `recognitions` for later evals.
 */
export async function readLabel(opts: {
  sb: SupabaseClient; userId: string; image: { data: Uint8Array; mime: string }; mediaId: string;
}): Promise<LabelReadResult> {
  const t0 = Date.now();
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Перепиши пищевую ценность с этикетки на фото.' },
      { type: 'file', mediaType: opts.image.mime || 'image/jpeg', data: opts.image.data },
    ],
  }];
  const chatgptAccessToken = await getChatgptToken(opts.userId).catch(() => null);
  const attempt = await genObject({
    task: 'vision',
    log: { userId: opts.userId, purpose: 'label' },
    system: labelSystemPrompt(),
    messages,
    schema: LabelOutput,
    temperature: 0,
    timeoutMs: LABEL_TIMEOUT_MS,
    maxOutputTokens: LABEL_MAX_OUTPUT_TOKENS,
    models: labelModelOrder(chatgptAccessToken),
    ctx: { chatgptAccessToken },
  });
  const raw = attempt.result;
  const cost = costUsd(attempt.ref.model, attempt.usage?.inputTokens, attempt.usage?.outputTokens);
  const run = {
    provider: attempt.ref.provider, model: attempt.ref.model, latency_ms: attempt.latencyMs,
    tokens_in: attempt.usage?.inputTokens, tokens_out: attempt.usage?.outputTokens, cost_usd: cost, raw,
  };
  const base = {
    user_id: opts.userId, kind: 'label', media_ids: [opts.mediaId],
    pipeline_version: LABEL_PROMPT_VERSION, prompt_version: LABEL_PROMPT_VERSION,
    runs: [run], latency_ms: Date.now() - t0, cost_usd: cost,
  };

  let label: NormalizedLabel;
  try {
    label = normalizeLabel(raw);
  } catch (e) {
    await opts.sb.from('recognitions').insert({ ...base, status: 'error', error: (e as Error).message });
    throw new LabelUnreadableError((e as Error).message);
  }
  const { data, error } = await opts.sb.from('recognitions')
    .insert({ ...base, result: label, confidence: label.confidence, status: 'done' })
    .select('id').single();
  if (error) console.error('[label] recognition save failed', error.message);
  return { recognitionId: (data?.id as string) ?? null, label, model: attempt.ref.model, latencyMs: Date.now() - t0 };
}
