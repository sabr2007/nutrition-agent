import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModelMessage } from 'ai';
import { genObject } from '@/lib/llm/generate';
import { costUsd } from '@/lib/llm/pricing';
import { LABEL_PROMPT_VERSION, LabelOutput, labelSystemPrompt, normalizeLabel, type NormalizedLabel } from './label';

export type LabelReadResult = { recognitionId: string | null; label: NormalizedLabel; model: string; latencyMs: number };

export class LabelUnreadableError extends Error {}

const LABEL_TIMEOUT_MS = 90_000;

/**
 * Reads a nutrition label photo: one vision call (transcription only), deterministic
 * normalization, and the raw model output stored in `recognitions`.
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
  const attempt = await genObject({
    task: 'vision',
    log: { userId: opts.userId, purpose: 'label' },
    system: labelSystemPrompt(),
    messages,
    schema: LabelOutput,
    timeoutMs: LABEL_TIMEOUT_MS,
  });
  const raw = attempt.result;
  const cost = costUsd(attempt.model, attempt.usage?.inputTokens, attempt.usage?.outputTokens);
  const run = {
    provider: 'chatgpt', model: attempt.model, latency_ms: attempt.latencyMs,
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
  return { recognitionId: (data?.id as string) ?? null, label, model: attempt.model, latencyMs: Date.now() - t0 };
}
